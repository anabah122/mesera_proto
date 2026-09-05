"""Журнал документа: нумерация, дедупликация, окна выборки.

Это фундамент протокола. Если idx поедет или txid задвоится, клиенты
разъедутся молча — поэтому проверяем инварианты, а не вызовы.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import tempfile
import threading
from pathlib import Path

from db import Database


def _db() -> Database:
    return Database(Path(tempfile.mkdtemp()) / "t.db")


def _append(db, doc="d:a:b", txid="t1", op="msg.send", author="u_a", body=None, ts=1):
    return db.append(doc=doc, txid=txid, op=op, author=author, body=body or {}, ts=ts)


def test_idx_starts_at_one_and_increments():
    db = _db()
    assert _append(db, txid="t1")["idx"] == 1
    assert _append(db, txid="t2")["idx"] == 2
    assert _append(db, txid="t3")["idx"] == 3


def test_idx_is_local_per_document():
    """Номера считаются внутри документа, а не глобально."""
    db = _db()
    assert _append(db, doc="d:a:b", txid="x")["idx"] == 1
    assert _append(db, doc="d:c:d", txid="y")["idx"] == 1, "счётчик протёк между документами"
    assert _append(db, doc="d:a:b", txid="z")["idx"] == 2


def test_same_txid_returns_original_entry():
    """Повтор отправки не создаёт вторую запись — иначе дубли в ленте."""
    db = _db()
    first = _append(db, txid="dup", body={"text": "привет"})
    second = _append(db, txid="dup", body={"text": "другое"})
    assert second["idx"] == first["idx"]
    assert second["payload"] == {"text": "привет"}, "повтор перезаписал тело"
    assert db.last_idx("d:a:b") == 1, "повтор сдвинул голову журнала"


def test_same_txid_in_other_document_is_a_new_entry():
    """txid уникален внутри документа, но не между ними."""
    db = _db()
    _append(db, doc="d:a:b", txid="same")
    other = _append(db, doc="d:c:d", txid="same")
    assert other["idx"] == 1


def test_last_idx_of_unknown_document_is_zero():
    assert _db().last_idx("d:nope:nope") == 0


def test_payload_survives_roundtrip():
    """Тело кладётся как JSON: юникод и вложенность должны вернуться целыми."""
    db = _db()
    body = {"text": "привет, мир", "nested": {"list": [1, 2, {"ok": True}]}, "none": None}
    _append(db, txid="j", body=body)
    assert db.entries_after("d:a:b", 0, 10)[0]["payload"] == body


def test_entries_after_is_exclusive_and_ordered():
    db = _db()
    for i in range(1, 6):
        _append(db, txid=f"t{i}")
    got = db.entries_after("d:a:b", 2, 10)
    assert [e["idx"] for e in got] == [3, 4, 5], "граница должна быть строгой"


def test_entries_after_respects_limit():
    db = _db()
    for i in range(1, 11):
        _append(db, txid=f"t{i}")
    assert [e["idx"] for e in db.entries_after("d:a:b", 0, 3)] == [1, 2, 3]


def test_entries_before_is_exclusive_and_ascending():
    """Окно вверх отдаётся по возрастанию, хотя выбирается с конца."""
    db = _db()
    for i in range(1, 11):
        _append(db, txid=f"t{i}")
    got = db.entries_before("d:a:b", 5, 3)
    assert [e["idx"] for e in got] == [2, 3, 4]


def test_tail_returns_last_entries_ascending():
    db = _db()
    for i in range(1, 11):
        _append(db, txid=f"t{i}")
    assert [e["idx"] for e in db.tail("d:a:b", 3)] == [8, 9, 10]


def test_concurrent_appends_get_unique_indexes():
    """Параллельная запись не должна выдать два одинаковых номера."""
    db = _db()
    seen, lock = [], threading.Lock()

    def worker(n):
        entry = _append(db, txid=f"c{n}")
        with lock:
            seen.append(entry["idx"])

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(seen) == list(range(1, 21)), f"номера разъехались: {sorted(seen)}"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
