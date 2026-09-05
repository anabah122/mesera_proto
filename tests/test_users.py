"""Пользователи: пароли, коллизии логинов, сессии, журнал состава."""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import secrets
import tempfile
from pathlib import Path

import dialogs
from db import Database
from users import UserError, Users


def _users() -> Users:
    return Users(Database(Path(tempfile.mkdtemp()) / "t.db"))


def _login() -> str:
    return "u_" + secrets.token_hex(4)


def _raises(fn, *a, **kw) -> str:
    try:
        fn(*a, **kw)
    except UserError as e:
        return str(e)
    raise AssertionError("ожидалась UserError, её не было")


# --- регистрация -----------------------------------------------------------

def test_register_returns_public_document():
    u = _users().register(_login(), "secret123", "Имя")
    assert u["id"].startswith("u_") and u["name"] == "Имя"
    # Секреты не должны просачиваться наружу ни при каких условиях.
    assert "pwd_hash" not in u and "pwd_salt" not in u


def test_login_is_normalised():
    """Регистр и пробелы не создают разных пользователей."""
    users = _users()
    login = _login()
    users.register("  " + login.upper() + "  ", "secret123", "Имя")
    assert users.login(login, "secret123")["login"] == login
    assert users.login(login.upper(), "secret123")["login"] == login


def test_duplicate_login_is_rejected():
    users = _users()
    login = _login()
    users.register(login, "secret123", "Первый")
    assert "занят" in _raises(users.register, login.upper(), "secret123", "Второй")


def test_short_input_is_rejected():
    users = _users()
    assert "логин" in _raises(users.register, "ab", "secret123", "Имя")
    assert "пароль" in _raises(users.register, _login(), "12345", "Имя")
    assert "имя" in _raises(users.register, _login(), "secret123", "   ")


def test_rejected_registration_leaves_nothing_behind():
    """Отказ не должен занимать логин наполовину."""
    users = _users()
    login = _login()
    _raises(users.register, login, "short", "Имя")
    assert users.register(login, "secret123", "Имя")["login"] == login


# --- пароли ----------------------------------------------------------------

def test_wrong_password_and_unknown_login_are_indistinguishable():
    """Текст ошибки одинаков: по нему нельзя перебирать логины."""
    users = _users()
    login = _login()
    users.register(login, "secret123", "Имя")
    assert _raises(users.login, login, "wrong") == _raises(users.login, _login(), "wrong")


def test_password_is_not_stored_in_plaintext():
    users = _users()
    login = _login()
    users.register(login, "secret123", "Имя")
    row = users._conn.execute("SELECT * FROM users WHERE login = ?", (login,)).fetchone()
    assert b"secret123" not in bytes(row["pwd_hash"])
    assert row["pwd_hash"] != b"secret123"


def test_same_password_gives_different_hashes():
    """Своя соль на пользователя: одинаковые пароли не совпадают в базе."""
    users = _users()
    a, b = _login(), _login()
    users.register(a, "secret123", "A")
    users.register(b, "secret123", "B")
    rows = {r["login"]: r["pwd_hash"] for r in users._conn.execute("SELECT * FROM users")}
    assert rows[a] != rows[b]


# --- сессии ----------------------------------------------------------------

def test_token_resolves_to_its_user():
    users = _users()
    user = users.register(_login(), "secret123", "Имя")
    assert users.by_token(users.open_session(user["id"]))["id"] == user["id"]


def test_unknown_token_resolves_to_nothing():
    users = _users()
    assert users.by_token("garbage") is None
    assert users.by_token("") is None


def test_sessions_are_independent():
    """Второй вход не отменяет первый: вкладки живут параллельно."""
    users = _users()
    user = users.register(_login(), "secret123", "Имя")
    first, second = users.open_session(user["id"]), users.open_session(user["id"])
    assert first != second
    assert users.by_token(first)["id"] == users.by_token(second)["id"] == user["id"]


# --- журнал состава --------------------------------------------------------

def test_log_add_is_idempotent():
    """Повторный вызов не заводит вторую запись о том же человеке."""
    users = _users()
    user = users.register(_login(), "secret123", "Имя")
    first = users.log_add(user)
    assert users.log_add(user)["idx"] == first["idx"]


def test_backfill_covers_pre_existing_users_once():
    users = _users()
    for _ in range(3):
        users.register(_login(), "secret123", "Имя")
    users.backfill()
    users.backfill()  # повтор ничего не задваивает
    entries = users._db.entries_after(dialogs.DOC_USERS, 0, 100)
    ids = [e["payload"]["id"] for e in entries]
    assert len(ids) == len(set(ids)) == 3


def test_journal_entry_carries_no_secrets():
    users = _users()
    user = users.register(_login(), "secret123", "Имя")
    payload = users.log_add(user)["payload"]
    assert "pwd_hash" not in payload and "pwd_salt" not in payload


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
