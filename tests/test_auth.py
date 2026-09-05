"""Проверка, что авторизация отделена от чата.

Регистрация и вход — чистый HTTP, работают без всякого WebSocket.
Токен из них принимается кадром HELLO, недействительный — отвергается.
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

# Своя база на прогон: тест повторяем и не трогает рабочие данные.
_tmp = Path(tempfile.mkdtemp()) / "test.db"
main.db = Database(_tmp)
main.users = Users(main.db)
app = main.app


def test_pages_are_separate():
    """Вход и чат — разные страницы на разных эндпоинтах."""
    with TestClient(app) as c:
        gate = c.get("/")
        assert gate.status_code == 200
        assert "auth.js" in gate.text
        # На странице входа нет ни чата, ни его скрипта.
        assert "app.js" not in gate.text
        assert 'id="app"' not in gate.text

        chat = c.get("/chat")
        assert chat.status_code == 200
        assert "app.js" in chat.text
        # На странице чата нет формы входа.
        assert 'id="auth"' not in chat.text

        # Разметка не кешируется, иначе правки не доезжают до браузера.
        assert gate.headers["cache-control"] == "no-cache"
        assert chat.headers["cache-control"] == "no-cache"


def test_auth_and_chat_are_separate():
    with TestClient(app) as c:
        LOGIN = "probe_" + secrets.token_hex(4)
        creds = {"login": LOGIN, "password": "secret123", "name": "Probe"}

        # Регистрация — только HTTP, сокет не открывается.
        r = c.post("/api/register", json=creds)
        assert r.status_code == 200, r.text
        token = r.json()["token"]
        assert r.json()["me"]["login"] == LOGIN

        # Повторная регистрация того же логина — внятная ошибка, не 500.
        assert c.post("/api/register", json=creds).status_code == 400

        # Вход выдаёт рабочий токен.
        r = c.post("/api/login", json={"login": LOGIN, "password": "secret123"})
        assert r.status_code == 200, r.text
        assert r.json()["token"]

        # Неверный пароль — 401 с текстом для пользователя.
        r = c.post("/api/login", json={"login": LOGIN, "password": "nope"})
        assert r.status_code == 401
        assert r.json()["detail"]

        # Чат принимает токен, выданный HTTP-слоем.
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": token, "cursors": {}})
            assert ws.receive_json()["t"] == "ready"
            # Между ready и synced едет журнал состава системы.
            while ws.receive_json()["t"] != "synced":
                pass

        # Недействительный токен отвергается кадром nack без txid —
        # клиент по нему возвращает пользователя на экран входа.
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": "garbage", "cursors": {}})
            f = ws.receive_json()
            assert f["t"] == "nack" and not f["txid"]


if __name__ == "__main__":
    test_pages_are_separate()
    test_auth_and_chat_are_separate()
    print("ok")
