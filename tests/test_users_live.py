"""Появление пользователя доезжает до открытых вкладок само.

Регистрация пишет транзакцию в журнал состава и рассылает её живым
соединениям. Вкладка, открытая до регистрации, получает EVT без
перезагрузки; вкладка, подключившаяся после, добирает то же самое
досылом по курсору.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import secrets
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import dialogs
import main
import users as users_mod
from db import Database
from users import Users

_tmp = Path(tempfile.mkdtemp()) / "test.db"
main.db = Database(_tmp)
main.users = Users(main.db)
main.hub._peers.clear()
app = main.app


def _creds(tag):
    return {"login": f"{tag}_{secrets.token_hex(3)}", "password": "secret123", "name": tag, "invite": users_mod.INVITE}


def test_new_user_reaches_open_tab():
    with TestClient(app) as c:
        alice = c.post("/api/register", json=_creds("alice")).json()

        # Вкладка Алисы открыта и досмотрела журнал до конца.
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": alice["token"], "cursors": {}})
            assert ws.receive_json()["t"] == "ready"
            frames = []
            while True:
                f = ws.receive_json()
                if f["t"] == "synced":
                    break
                frames.append(f)
            # Себя Алиса уже видит из журнала состава.
            assert any(f.get("op") == "user.add" for f in frames)

            # Пока вкладка открыта, регистрируется Боб.
            bob = c.post("/api/register", json=_creds("bob")).json()

            # Транзакция приходит сама, без переподключения.
            f = ws.receive_json()
            assert f["t"] == "evt"
            assert f["doc"] == dialogs.DOC_USERS
            assert f["op"] == "user.add"
            assert f["payload"]["id"] == bob["me"]["id"]
            # Пароль в транзакции не уезжает.
            assert "pwd_hash" not in f["payload"] and "pwd_salt" not in f["payload"]


def test_late_tab_backfills_by_cursor():
    """Вкладка, пропустившая событие, добирает его досылом по курсору."""
    with TestClient(app) as c:
        carol = c.post("/api/register", json=_creds("carol")).json()
        dave = c.post("/api/register", json=_creds("dave")).json()

        with c.websocket_connect("/ws") as ws:
            # Курсора по журналу состава нет вовсе — сервер шлёт его с нуля.
            ws.send_json({"t": "hello", "token": carol["token"], "cursors": {}})
            assert ws.receive_json()["t"] == "ready"
            seen = []
            while True:
                f = ws.receive_json()
                if f["t"] == "synced":
                    break
                if f.get("doc") == dialogs.DOC_USERS:
                    seen.append(f["payload"]["id"])
            assert dave["me"]["id"] in seen, "новый пользователь не доехал досылом"


def test_client_cannot_forge_users_journal():
    """В журнал состава пишет только сервер."""
    with TestClient(app) as c:
        eve = c.post("/api/register", json=_creds("eve")).json()
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": eve["token"], "cursors": {}})
            while ws.receive_json()["t"] != "synced":
                pass
            ws.send_json({
                "t": "tx", "txid": "forged", "doc": dialogs.DOC_USERS,
                "op": "user.add", "payload": {"id": "u_fake", "name": "Fake"},
            })
            f = ws.receive_json()
            assert f["t"] == "nack", f


def test_heartbeat_delivers_missed_users():
    """PING с курсорами досылает пропущенное, не дожидаясь переподключения."""
    with TestClient(app) as c:
        frank = c.post("/api/register", json=_creds("frank")).json()
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": frank["token"], "cursors": {}})
            while ws.receive_json()["t"] != "synced":
                pass

            grace = c.post("/api/register", json=_creds("grace")).json()
            ws.receive_json()  # прилетело рассылкой

            # Клиент сверяется устаревшим курсором — сервер досылает заново.
            ws.send_json({"t": "ping", "doc": "", "idx": 0, "users_idx": 0, "ts": 1})
            got = []
            while True:
                f = ws.receive_json()
                if f["t"] == "pong":
                    assert f["ts"] > 0, "pong без серверного времени"
                    break
                got.append(f["payload"]["id"])
            assert grace["me"]["id"] in got


if __name__ == "__main__":
    test_new_user_reaches_open_tab()
    test_late_tab_backfills_by_cursor()
    test_client_cannot_forge_users_journal()
    test_heartbeat_delivers_missed_users()
    print("ok")
