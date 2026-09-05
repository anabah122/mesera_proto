"""Реестр живых соединений.

Доставка адресуется по пользователю, у одного может быть много вкладок.
Мёртвый сокет не должен ломать рассылку остальным.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import asyncio

from hub import Hub


class FakeSocket:
    """Сокет, который считает доставленное. Может притвориться мёртвым."""

    def __init__(self, dead=False):
        self.frames = []
        self.dead = dead

    async def send_json(self, frame):
        if self.dead:
            raise ConnectionError("сокет закрыт")
        self.frames.append(frame)


def run(coro):
    return asyncio.run(coro)


def test_frame_reaches_every_tab_of_a_user():
    hub = Hub()
    a, b = FakeSocket(), FakeSocket()
    hub.add("u1", a)
    hub.add("u1", b)
    run(hub.send_to(["u1"], {"t": "evt"}))
    assert a.frames == b.frames == [{"t": "evt"}]


def test_skip_excludes_the_author_socket():
    hub = Hub()
    author, other = FakeSocket(), FakeSocket()
    hub.add("u1", author)
    hub.add("u1", other)
    run(hub.send_to(["u1"], {"t": "evt"}, skip=author))
    assert author.frames == []
    assert other.frames == [{"t": "evt"}]


def test_unknown_user_is_not_an_error():
    run(Hub().send_to(["nobody"], {"t": "evt"}))


def test_dead_socket_is_dropped_and_others_still_get_the_frame():
    hub = Hub()
    dead, alive = FakeSocket(dead=True), FakeSocket()
    hub.add("u1", dead)
    hub.add("u1", alive)
    run(hub.send_to(["u1"], {"t": "evt"}))
    assert alive.frames == [{"t": "evt"}], "живой сокет пострадал из-за мёртвого"
    assert dead not in hub._peers.get("u1", ()), "мёртвый сокет не отцеплен"


def test_remove_clears_empty_user_entry():
    """Пустые записи не копятся: иначе broadcast разрастается мусором."""
    hub = Hub()
    ws = FakeSocket()
    hub.add("u1", ws)
    hub.remove("u1", ws)
    assert "u1" not in hub._peers


def test_remove_is_safe_to_repeat():
    hub = Hub()
    ws = FakeSocket()
    hub.add("u1", ws)
    hub.remove("u1", ws)
    hub.remove("u1", ws)
    hub.remove("unknown", ws)


def test_adding_same_socket_twice_delivers_once():
    hub = Hub()
    ws = FakeSocket()
    hub.add("u1", ws)
    hub.add("u1", ws)
    run(hub.send_to(["u1"], {"t": "evt"}))
    assert ws.frames == [{"t": "evt"}], "кадр задвоился"


def test_broadcast_reaches_all_users():
    hub = Hub()
    a, b = FakeSocket(), FakeSocket()
    hub.add("u1", a)
    hub.add("u2", b)
    run(hub.broadcast({"t": "evt"}))
    assert a.frames and b.frames


def test_broadcast_survives_disconnect_mid_iteration():
    """Отцепление мёртвого сокета не должно ронять обход реестра."""
    hub = Hub()
    hub.add("u1", FakeSocket(dead=True))
    hub.add("u2", FakeSocket(dead=True))
    alive = FakeSocket()
    hub.add("u3", alive)
    run(hub.broadcast({"t": "evt"}))
    assert alive.frames == [{"t": "evt"}]
    assert "u1" not in hub._peers and "u2" not in hub._peers


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
