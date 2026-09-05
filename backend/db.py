"""Документное хранилище поверх SQLite.

Документ — логическая единица с собственным журналом транзакций.
Физически журнал хранится построчно: перезаписи всего документа при
добавлении записи не происходит, поэтому размер журнала на объём
операции не влияет.

Счётчик idx локальный для каждого документа. Выдаётся внутри той же
транзакции, что и вставка, поэтому порядок номеров равен порядку коммита.
"""

import json
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id       TEXT PRIMARY KEY,
    login    TEXT NOT NULL UNIQUE,
    name     TEXT NOT NULL,
    avatar   TEXT,
    pwd_salt BLOB NOT NULL,
    pwd_hash BLOB NOT NULL,
    created  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created INTEGER NOT NULL
);

-- Голова журнала каждого документа. Отдельная таблица, чтобы выдача
-- следующего номера была одним UPDATE, а не сканированием журнала.
CREATE TABLE IF NOT EXISTS doc_head (
    doc      TEXT PRIMARY KEY,
    last_idx INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    doc    TEXT    NOT NULL,
    idx    INTEGER NOT NULL,
    txid   TEXT    NOT NULL,
    op     TEXT    NOT NULL,
    author TEXT    NOT NULL,
    body   TEXT    NOT NULL,
    ts     INTEGER NOT NULL,
    PRIMARY KEY (doc, idx)
) WITHOUT ROWID;

-- Дедупликация повторной отправки: txid уникален в пределах документа.
CREATE UNIQUE INDEX IF NOT EXISTS entries_txid ON entries(doc, txid);
"""


class Database:
    def __init__(self, path: Path):
        # Соединение одно на всё приложение и делится между потоками:
        # синхронные обработчики uvicorn выполняются в пуле. sqlite3 не
        # сериализует такие вызовы сам — курсоры затрут друг друга, — поэтому
        # каждый доступ идёт под общим мьютексом.
        # ponytail: один мьютекс на базу, пул соединений если упрёмся в запись
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- журналы документов -------------------------------------------------

    def append(self, doc: str, txid: str, op: str, author: str, body: dict, ts: int) -> dict:
        """Добавляет запись в журнал документа, присваивая следующий номер.

        Номер и вставка — одна транзакция, поэтому параллельные вызовы не
        могут получить одинаковый idx. Повторный txid возвращает исходную
        запись, не создавая вторую.
        """
        with self._lock, self._conn:
            known = self._entry_by_txid(doc, txid)
            if known:
                return known

            cur = self._conn.execute(
                "INSERT INTO doc_head(doc, last_idx) VALUES(?, 1) "
                "ON CONFLICT(doc) DO UPDATE SET last_idx = last_idx + 1 "
                "RETURNING last_idx",
                (doc,),
            )
            idx = cur.fetchone()["last_idx"]

            self._conn.execute(
                "INSERT INTO entries(doc, idx, txid, op, author, body, ts) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (doc, idx, txid, op, author, json.dumps(body, ensure_ascii=False), ts),
            )

        return {
            "doc": doc, "idx": idx, "txid": txid, "op": op,
            "author": author, "payload": body, "ts": ts,
        }

    def entry_by_txid(self, doc: str, txid: str) -> dict | None:
        with self._lock:
            return self._entry_by_txid(doc, txid)

    def _entry_by_txid(self, doc: str, txid: str) -> dict | None:
        """Без блокировки: зовётся изнутри уже захваченной секции."""
        row = self._conn.execute(
            "SELECT * FROM entries WHERE doc = ? AND txid = ?", (doc, txid)
        ).fetchone()
        return _entry(row) if row else None

    def last_idx(self, doc: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT last_idx FROM doc_head WHERE doc = ?", (doc,)
            ).fetchone()
        return row["last_idx"] if row else 0

    def entries_after(self, doc: str, idx: int, limit: int) -> list[dict]:
        """Записи с номером строго больше указанного, по возрастанию."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM entries WHERE doc = ? AND idx > ? ORDER BY idx LIMIT ?",
                (doc, idx, limit),
            ).fetchall()
        return [_entry(r) for r in rows]

    def entries_before(self, doc: str, idx: int, limit: int) -> list[dict]:
        """Окно истории вверх от номера. Возвращается по возрастанию."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM entries WHERE doc = ? AND idx < ? ORDER BY idx DESC LIMIT ?",
                (doc, idx, limit),
            ).fetchall()
        return [_entry(r) for r in reversed(rows)]

    def tail(self, doc: str, limit: int) -> list[dict]:
        """Последние записи документа — стартовое окно клиента."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM entries WHERE doc = ? ORDER BY idx DESC LIMIT ?",
                (doc, limit),
            ).fetchall()
        return [_entry(r) for r in reversed(rows)]


def _entry(row: sqlite3.Row) -> dict:
    return {
        "doc": row["doc"],
        "idx": row["idx"],
        "txid": row["txid"],
        "op": row["op"],
        "author": row["author"],
        "payload": json.loads(row["body"]),
        "ts": row["ts"],
    }
