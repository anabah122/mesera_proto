"""Регистрация закрыта словом-приглашением."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import secrets
import tempfile

from fastapi.testclient import TestClient

import main
import users as users_mod
from db import Database
from users import UserError, Users

main.db = Database(Path(tempfile.mkdtemp()) / "test.db")
main.users = Users(main.db)
app = main.app


def _body(**over):
    body = {
        "login": "inv_" + secrets.token_hex(4),
        "password": "secret123",
        "name": "Приглашённый",
        "invite": users_mod.INVITE,
    }
    body.update(over)
    return body


def test_registration_needs_the_invite_word():
    with TestClient(app) as c:
        assert c.post("/api/register", json=_body()).status_code == 200


def test_wrong_or_missing_invite_is_refused():
    with TestClient(app) as c:
        for bad in ("", "wrong", users_mod.INVITE.upper() + "x", " "):
            res = c.post("/api/register", json=_body(invite=bad))
            assert res.status_code == 400, f"пропущено слово {bad!r}"
            assert "секретное" in res.json()["detail"]


def test_invite_is_trimmed_not_case_folded():
    """Пробелы прощаем, регистр — нет: слово остаётся словом."""
    with TestClient(app) as c:
        assert c.post("/api/register", json=_body(invite=f"  {users_mod.INVITE}  ")).status_code == 200
        assert c.post("/api/register", json=_body(invite=users_mod.INVITE.upper())).status_code == 400


def test_login_does_not_ask_for_the_invite():
    """Слово нужно один раз, при заведении: вход им не загораживаем."""
    with TestClient(app) as c:
        body = _body()
        c.post("/api/register", json=body)
        res = c.post("/api/login", json={"login": body["login"], "password": body["password"]})
        assert res.status_code == 200


def test_refused_registration_leaves_no_user():
    with TestClient(app) as c:
        body = _body(invite="wrong")
        c.post("/api/register", json=body)
        # Логин остался свободным — значит запись не завелась.
        assert c.post("/api/register", json=_body(login=body["login"])).status_code == 200


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
