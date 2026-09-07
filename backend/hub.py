"""Реестр живых соединений, адресуемых по пользователю.

У одного пользователя может быть несколько открытых вкладок, поэтому на
идентификатор приходится набор сокетов.
"""

from fastapi import WebSocket


class Hub:
    def __init__(self):
        self._peers: dict[str, set[WebSocket]] = {}
        # Вкладки на виду. Присутствие считается по ним, а не по всем
        # сокетам: открытое в фоне окно — ещё не «в сети».
        self._active: dict[str, set[WebSocket]] = {}

    def add(self, user_id: str, ws: WebSocket) -> bool:
        """Регистрирует сокет. True — человек только что появился в сети."""
        self._peers.setdefault(user_id, set()).add(ws)
        return self.wake(user_id, ws)

    def remove(self, user_id: str, ws: WebSocket) -> bool:
        """Убирает сокет. True — человек перестал быть в сети."""
        peers = self._peers.get(user_id)
        if peers:
            peers.discard(ws)
            if not peers:
                del self._peers[user_id]
        return self.idle(user_id, ws)

    def wake(self, user_id: str, ws: WebSocket) -> bool:
        """Вкладка вышла на передний план. True — человек появился в сети."""
        active = self._active.setdefault(user_id, set())
        was_empty = not active
        active.add(ws)
        return was_empty

    def idle(self, user_id: str, ws: WebSocket) -> bool:
        """Вкладка ушла в фон или закрылась. True — человек ушёл."""
        active = self._active.get(user_id)
        if not active:
            return False
        active.discard(ws)
        if active:
            return False
        del self._active[user_id]
        return True

    def is_online(self, user_id: str) -> bool:
        return user_id in self._active

    def online(self) -> list[str]:
        return list(self._active)

    async def send_to(self, user_ids, frame: dict, skip: WebSocket | None = None) -> None:
        """Доставляет кадр всем соединениям перечисленных пользователей.

        Мёртвые сокеты отсеиваются молча: пропущенное они доберут по HELLO
        при переподключении.
        """
        for user_id in user_ids:
            for ws in list(self._peers.get(user_id, ())):
                if ws is skip:
                    continue
                try:
                    await ws.send_json(frame)
                except Exception:
                    self.remove(user_id, ws)

    async def broadcast(self, frame: dict, skip: WebSocket | None = None) -> None:
        await self.send_to(list(self._peers), frame, skip)
