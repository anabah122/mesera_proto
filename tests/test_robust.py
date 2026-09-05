"""Соединение переживает кривые кадры.

Клиентские поля не доверенные: мусор в числах и типах не должен ронять
сокет — иначе один сломанный клиент рвёт себе сессию на ровном месте.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import secrets
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import main
from db import Database
from users import Users

_tmp = Path(tempfile.mkdtemp()) / "test.db"
main.db = Database(_tmp)
main.users = Users(main.db)
app = main.app


def _token(c):
    body = {"login": "r_" + secrets.token_hex(4), "password": "secret123", "name": "R"}
    return c.post("/api/register", json=body).json()["token"]


def _sync(ws, token):
    ws.send_json({"t": "hello", "token": token, "cursors": {}})
    while ws.receive_json()["t"] != "synced":
        pass


def test_garbage_frames_keep_connection():
    with TestClient(app) as c:
        token = _token(c)
        with c.websocket_connect("/ws") as ws:
            # Не-JSON до всякой авторизации.
            ws.send_text("not json{{")
            f = ws.receive_json()
            assert f["t"] == "nack" and not f["fatal"], "кривой кадр не должен рвать сессию"

            _sync(ws, token)

            # Мусор в числовых полях и неверные типы.
            for bad in (
                {"t": "fetch", "doc": "users", "before": "nope"},
                {"t": "fetch", "doc": 42},
                {"t": "ping", "doc": "users", "idx": "x", "ts": "y", "users_idx": None},
                {"t": "tx", "txid": None, "doc": "users"},
                {"t": "tx", "txid": "a", "doc": {"not": "a string"}},
            ):
                ws.send_json(bad)

            # Соединение живо и отвечает.
            ws.send_json({"t": "ping"})
            while ws.receive_json()["t"] != "pong":
                pass


def test_only_session_nack_is_fatal():
    """Клиент выкидывает на вход только по fatal, не по любому отказу."""
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": "garbage", "cursors": {}})
            f = ws.receive_json()
            assert f["t"] == "nack" and f["fatal"] is True

        token = _token(c)
        with c.websocket_connect("/ws") as ws:
            _sync(ws, token)
            # Отказ по правам — транзакционный, сессию не рвёт.
            ws.send_json({"t": "tx", "txid": "t1", "doc": "users", "op": "user.add", "payload": {}})
            f = ws.receive_json()
            assert f["t"] == "nack" and f["fatal"] is False


def test_double_hello_does_not_duplicate_peer():
    """Повторный HELLO по тому же сокету не задваивает подписку."""
    with TestClient(app) as c:
        token = _token(c)
        with c.websocket_connect("/ws") as ws:
            _sync(ws, token)
            _sync(ws, token)
            sockets = sum(len(v) for v in main.hub._peers.values())
            assert sockets == 1, f"сокет задвоен в hub: {sockets}"


if __name__ == "__main__":
    test_garbage_frames_keep_connection()
    test_only_session_nack_is_fatal()
    test_double_hello_does_not_duplicate_peer()
    print("ok")
