"""Реестр живых соединений, адресуемых по пользователю.

У одного пользователя может быть несколько открытых вкладок, поэтому на
идентификатор приходится набор сокетов.
"""

from fastapi import WebSocket


class Hub:
    def __init__(self):
        self._peers: dict[str, set[WebSocket]] = {}

    def add(self, user_id: str, ws: WebSocket) -> None:
        self._peers.setdefault(user_id, set()).add(ws)

    def remove(self, user_id: str, ws: WebSocket) -> None:
        peers = self._peers.get(user_id)
        if not peers:
            return
        peers.discard(ws)
        if not peers:
            del self._peers[user_id]

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
