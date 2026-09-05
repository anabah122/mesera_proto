"""Пользователи и сессии.

Пароль хранится как scrypt-хэш со своей солью на каждого пользователя.
Токен сессии — случайный, живёт в базе; клиент держит его у себя и
предъявляет в кадре HELLO.
"""

import hashlib
import hmac
import secrets
import sqlite3
import time

from db import Database

# Параметры scrypt: цена памяти, размер блока, параллелизм.
_N, _R, _P = 2 ** 14, 8, 1


def _derive(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)


class UserError(Exception):
    """Ошибка, которую можно показать пользователю."""


class Users:
    def __init__(self, db: Database):
        self._db = db
        self._conn = db._conn

    def register(self, login: str, password: str, name: str) -> dict:
        login = login.strip().lower()
        name = name.strip()
        if len(login) < 3:
            raise UserError("логин короче трёх символов")
        if len(password) < 6:
            raise UserError("пароль короче шести символов")
        if not name:
            raise UserError("имя не заполнено")

        salt = secrets.token_bytes(16)
        user = {
            "id": "u_" + secrets.token_hex(8),
            "login": login,
            "name": name,
            "avatar": None,
            "created": int(time.time() * 1000),
        }
        try:
            with self._conn:
                self._conn.execute(
                    "INSERT INTO users(id, login, name, avatar, pwd_salt, pwd_hash, created) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?)",
                    (user["id"], login, name, None, salt, _derive(password, salt), user["created"]),
                )
        except sqlite3.IntegrityError:
            raise UserError("логин занят")
        return user

    def login(self, login: str, password: str) -> dict:
        row = self._conn.execute(
            "SELECT * FROM users WHERE login = ?", (login.strip().lower(),)
        ).fetchone()
        # Сравнение постоянного времени; при отсутствии пользователя всё равно
        # считаем хэш, чтобы по времени ответа нельзя было перебрать логины.
        salt = row["pwd_salt"] if row else b"\x00" * 16
        expect = row["pwd_hash"] if row else b"\x00" * 32
        ok = hmac.compare_digest(_derive(password, salt), expect)
        if not row or not ok:
            raise UserError("неверный логин или пароль")
        return _public(row)

    def open_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(24)
        with self._conn:
            self._conn.execute(
                "INSERT INTO sessions(token, user_id, created) VALUES(?, ?, ?)",
                (token, user_id, int(time.time() * 1000)),
            )
        return token

    def by_token(self, token: str) -> dict | None:
        row = self._conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
            (token,),
        ).fetchone()
        return _public(row) if row else None

    def by_id(self, user_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _public(row) if row else None

    def all(self) -> list[dict]:
        """Внутри системы все видят всех."""
        rows = self._conn.execute("SELECT * FROM users ORDER BY name").fetchall()
        return [_public(r) for r in rows]


def _public(row: sqlite3.Row) -> dict:
    """Документ пользователя без секретов."""
    return {
        "id": row["id"],
        "login": row["login"],
        "name": row["name"],
        "avatar": row["avatar"],
        "created": row["created"],
    }
