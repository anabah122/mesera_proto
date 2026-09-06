"""Несколько вкладок одного пользователя работают одновременно.

Токен у каждой вкладки свой, но сервер не считает их конкурентами:
ни одна не уходит в read-only, все пишут и получают чужие транзакции.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import secrets
import tempfile

from fastapi.testclient import TestClient

import dialogs
import main
import users as users_mod
from db import Database
from users import Users

main.db = Database(Path(tempfile.mkdtemp()) / "test.db")
main.users = Users(main.db)
app = main.app


def _creds(tag):
    return {"login": f"{tag}_{secrets.token_hex(4)}", "password": "secret123", "name": tag, "invite": users_mod.INVITE}


def _sync(ws, token):
    ws.send_json({"t": "hello", "token": token, "cursors": {}})
    while ws.receive_json()["t"] != "synced":
        pass


def test_login_issues_a_fresh_token_each_time():
    """Каждая вкладка получает свой токен: они не вытесняют друг друга."""
    with TestClient(app) as c:
        body = _creds("multi")
        first = c.post("/api/register", json=body).json()["token"]
        second = c.post("/api/login", json=body).json()["token"]
        third = c.post("/api/login", json=body).json()["token"]

        assert len({first, second, third}) == 3, "токен переиспользован"
        for token in (first, second, third):
            assert main.users.by_token(token), "выданный токен перестал работать"


def test_every_tab_can_write():
    """Ключевое требование: ни одна вкладка не уходит в read-only."""
    with TestClient(app) as c:
        body = _creds("author")
        tab1 = c.post("/api/register", json=body).json()
        tab2_token = c.post("/api/login", json=body).json()["token"]
        peer = c.post("/api/register", json=_creds("peer")).json()
        doc = dialogs.dialog_id(tab1["me"]["id"], peer["me"]["id"])

        with c.websocket_connect("/ws") as w1, c.websocket_connect("/ws") as w2:
            _sync(w1, tab1["token"])
            _sync(w2, tab2_token)

            # Первая вкладка пишет — вторая видит.
            w1.send_json({"t": "tx", "txid": "a1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "из первой"}})
            assert w1.receive_json()["t"] == "ack"
            assert w2.receive_json()["payload"]["text"] == "из первой"

            # Вторая вкладка тоже пишет — значит не read-only.
            w2.send_json({"t": "tx", "txid": "a2", "doc": doc,
                          "op": "msg.send", "payload": {"text": "из второй"}})
            ack = w2.receive_json()
            assert ack["t"] == "ack", f"вторая вкладка не смогла писать: {ack}"
            assert w1.receive_json()["payload"]["text"] == "из второй"


def test_tabs_get_consecutive_indexes():
    """Параллельная запись из вкладок не ломает нумерацию журнала."""
    with TestClient(app) as c:
        body = _creds("seq")
        tab1 = c.post("/api/register", json=body).json()
        tab2_token = c.post("/api/login", json=body).json()["token"]
        peer = c.post("/api/register", json=_creds("peer")).json()
        doc = dialogs.dialog_id(tab1["me"]["id"], peer["me"]["id"])

        seen = []
        with c.websocket_connect("/ws") as w1, c.websocket_connect("/ws") as w2:
            _sync(w1, tab1["token"])
            _sync(w2, tab2_token)
            for i in range(3):
                for ws, tag in ((w1, "t1"), (w2, "t2")):
                    ws.send_json({"t": "tx", "txid": f"{tag}-{i}", "doc": doc,
                                  "op": "msg.send", "payload": {"text": tag}})
                    while True:
                        f = ws.receive_json()
                        if f["t"] == "ack":
                            seen.append(f["idx"])
                            break

        assert sorted(seen) == list(range(1, 7)), f"номера разъехались: {sorted(seen)}"


def test_closing_one_tab_leaves_the_other_working():
    """Закрытие вкладки не рвёт сессию соседней."""
    with TestClient(app) as c:
        body = _creds("close")
        tab1 = c.post("/api/register", json=body).json()
        tab2_token = c.post("/api/login", json=body).json()["token"]
        peer = c.post("/api/register", json=_creds("peer")).json()
        doc = dialogs.dialog_id(tab1["me"]["id"], peer["me"]["id"])

        with c.websocket_connect("/ws") as survivor:
            _sync(survivor, tab2_token)
            with c.websocket_connect("/ws") as doomed:
                _sync(doomed, tab1["token"])
            # Соседняя вкладка закрылась — эта продолжает писать.
            survivor.send_json({"t": "tx", "txid": "s1", "doc": doc,
                                "op": "msg.send", "payload": {"text": "жива"}})
            assert survivor.receive_json()["t"] == "ack"


def test_each_tab_keeps_its_own_hub_socket():
    """Разные токены одного человека — разные сокеты в реестре доставки."""
    with TestClient(app) as c:
        body = _creds("hub")
        tab1 = c.post("/api/register", json=body).json()
        tab2_token = c.post("/api/login", json=body).json()["token"]
        user_id = tab1["me"]["id"]

        with c.websocket_connect("/ws") as w1, c.websocket_connect("/ws") as w2:
            _sync(w1, tab1["token"])
            _sync(w2, tab2_token)
            assert len(main.hub._peers.get(user_id, ())) == 2, "вкладки слились в один сокет"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
