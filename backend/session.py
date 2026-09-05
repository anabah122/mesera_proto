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


def _num(value, default: int = 0) -> int:
    """Число из клиентского поля. Мусор — значение по умолчанию, не падение."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class Session:
    def __init__(self, ws: WebSocket, db: Database, users: Users, hub: Hub):
        self._ws = ws
        self._db = db
        self._users = users
        self._hub = hub
        self._me: dict | None = None
        self._closed = False

    @property
    def user_id(self) -> str | None:
        return self._me["id"] if self._me else None

    async def handle(self, frame: dict) -> bool:
        """Разбирает кадр. False — соединение закрыто, читать больше нечего."""
        t = frame.get("t")
        if t == p.PING:
            await self._on_ping(frame)
        elif t == p.HELLO:
            await self._on_hello(frame)
        elif self._me is None:
            await self._ws.send_json(p.nack(frame.get("txid", ""), "нет сессии"))
        elif t == p.TX:
            await self._on_tx(frame)
        elif t == p.FETCH:
            await self._on_fetch(frame)
        return not self._closed

    async def close(self) -> None:
        if self._me:
            self._hub.remove(self._me["id"], self._ws)

    # --- кадры --------------------------------------------------------------

    async def _on_hello(self, frame: dict) -> None:
        me = self._users.by_token(frame.get("token", ""))
        if not me:
            # Отказ без txid относится к сессии целиком: клиент по нему
            # чистит токен и возвращает пользователя на экран входа.
            await self._ws.send_json(p.nack("", "сессия недействительна", fatal=True))
            self._closed = True
            await self._ws.close()
            return

        # Повторный HELLO по тому же сокету не должен задваивать подписку.
        if self._me:
            self._hub.remove(self._me["id"], self._ws)
        self._me = me
        self._hub.add(me["id"], self._ws)
        await self._ws.send_json(p.ready(me, self._users.all()))

        # Клиент присылает свой курсор по каждому известному ему документу.
        # Ответ — только то, чего у него нет.
        cursors: dict[str, int] = dict(frame.get("cursors") or {})
        # Состав системы клиент получает всегда: без него не из чего строить
        # список диалогов. Курсора нет — досылаем журнал с начала.
        cursors.setdefault(dialogs.DOC_USERS, 0)
        heads: dict[str, int] = {}

        for doc, cursor in cursors.items():
            if not dialogs.can_read(doc, me["id"]):
                continue
            head = self._db.last_idx(doc)
            heads[doc] = head
            since = _num(cursor)
            if head - since > GAP_LIMIT:
                await self._ws.send_json(p.reset(doc, head))
                continue
            for entry in self._db.entries_after(doc, since, GAP_LIMIT):
                await self._ws.send_json(p.evt(entry))

        await self._ws.send_json(p.synced(heads))

    async def _on_ping(self, frame: dict) -> None:
        """Живость + сверка курсоров.

        Клиент присылает idx открытого диалога и ts последнего общего
        действия. Расхождение — досылаем пропущенное прямо в ответ, не
        дожидаясь переподключения.
        """
        if self._me is None:
            await self._ws.send_json(p.pong(int(time.time() * 1000)))
            return

        doc = frame.get("doc")
        if isinstance(doc, str) and doc and dialogs.can_read(doc, self._me["id"]):
            idx = _num(frame.get("idx"))
            head = self._db.last_idx(doc)
            if head > idx:
                for entry in self._db.entries_after(doc, idx, GAP_LIMIT):
                    await self._ws.send_json(p.evt(entry))

        # Общие действия сверяем по времени: клиент не знает их номеров,
        # но знает, чем он располагал на последнюю сверку.
        since = _num(frame.get("ts"))
        if since:
            for entry in self._db.entries_after(
                dialogs.DOC_USERS, _num(frame.get("users_idx")), GAP_LIMIT
            ):
                if entry["ts"] > since:
                    await self._ws.send_json(p.evt(entry))

        await self._ws.send_json(p.pong(int(time.time() * 1000)))

    async def _on_tx(self, frame: dict) -> None:
        txid = frame.get("txid")
        doc = frame.get("doc")
        if not isinstance(txid, str) or not txid or not isinstance(doc, str):
            return
        if not dialogs.can_write(doc, self._me["id"]):
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
        doc = frame.get("doc")
        if not isinstance(doc, str):
            return
        if not dialogs.can_read(doc, self._me["id"]):
            return
        before = _num(frame.get("before"))
        limit = max(1, min(_num(frame.get("limit"), GAP_LIMIT), GAP_LIMIT))
        entries = (
            self._db.tail(doc, limit) if before <= 0
            else self._db.entries_before(doc, before, limit)
        )
        for entry in entries:
            await self._ws.send_json(p.evt(entry))
