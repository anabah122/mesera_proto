"""Обработка кадров одного соединения."""

import time

from fastapi import WebSocket

import dialogs
import protocol as p
from db import Database
from hub import Hub
from users import Users

# Сколько записей досылаем поштучно после разрыва. Больше — отдаём RESET,
# клиент забирает хвост через HTTP.
GAP_LIMIT = 1000


class Session:
    def __init__(self, ws: WebSocket, db: Database, users: Users, hub: Hub):
        self._ws = ws
        self._db = db
        self._users = users
        self._hub = hub
        self._me: dict | None = None

    @property
    def user_id(self) -> str | None:
        return self._me["id"] if self._me else None

    async def handle(self, frame: dict) -> None:
        t = frame.get("t")
        if t == p.PING:
            await self._ws.send_json(p.pong())
        elif t == p.HELLO:
            await self._on_hello(frame)
        elif self._me is None:
            await self._ws.send_json(p.nack(frame.get("txid", ""), "нет сессии"))
        elif t == p.TX:
            await self._on_tx(frame)
        elif t == p.FETCH:
            await self._on_fetch(frame)

    async def close(self) -> None:
        if self._me:
            self._hub.remove(self._me["id"], self._ws)

    # --- кадры --------------------------------------------------------------

    async def _on_hello(self, frame: dict) -> None:
        me = self._users.by_token(frame.get("token", ""))
        if not me:
            await self._ws.send_json(p.nack("", "сессия недействительна"))
            await self._ws.close()
            return

        self._me = me
        self._hub.add(me["id"], self._ws)
        await self._ws.send_json(p.ready(me, self._users.all()))

        # Клиент присылает свой курсор по каждому известному ему документу.
        # Ответ — только то, чего у него нет.
        cursors: dict[str, int] = frame.get("cursors") or {}
        heads: dict[str, int] = {}

        for doc, cursor in cursors.items():
            if not dialogs.is_member(doc, me["id"]):
                continue
            head = self._db.last_idx(doc)
            heads[doc] = head
            if head - int(cursor) > GAP_LIMIT:
                await self._ws.send_json(p.reset(doc, head))
                continue
            for entry in self._db.entries_after(doc, int(cursor), GAP_LIMIT):
                await self._ws.send_json(p.evt(entry))

        await self._ws.send_json(p.synced(heads))

    async def _on_tx(self, frame: dict) -> None:
        txid = frame.get("txid")
        doc = frame.get("doc", "")
        if not txid:
            return
        if not dialogs.is_member(doc, self._me["id"]):
            await self._ws.send_json(p.nack(txid, "нет доступа к документу"))
            return

        entry = self._db.append(
            doc=doc,
            txid=txid,
            op=frame.get("op", ""),
            author=self._me["id"],
            body=frame.get("payload") or {},
            ts=int(time.time() * 1000),
        )

        await self._ws.send_json(p.ack(txid, doc, entry["idx"]))
        # Тот же коммит уходит собеседнику и другим вкладкам автора.
        await self._hub.send_to(dialogs.members(doc), p.evt(entry), skip=self._ws)

    async def _on_fetch(self, frame: dict) -> None:
        """Добор окна истории вверх: последние записи до указанного номера."""
        doc = frame.get("doc", "")
        if not dialogs.is_member(doc, self._me["id"]):
            return
        before = int(frame.get("before", 0))
        limit = min(int(frame.get("limit", GAP_LIMIT)), GAP_LIMIT)
        entries = (
            self._db.tail(doc, limit) if before <= 0
            else self._db.entries_before(doc, before, limit)
        )
        for entry in entries:
            await self._ws.send_json(p.evt(entry))
