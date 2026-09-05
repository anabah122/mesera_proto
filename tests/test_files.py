"""Вложения: приём, отдача, ограничения.

Тела идут мимо сокета: файл ложится на диск, а в журнал попадает только
его идентификатор.
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
from db import Database
from files import FileError, Files
from users import Users

_tmp = Path(tempfile.mkdtemp())
main.db = Database(_tmp / "test.db")
main.users = Users(main.db)
main.files = Files(_tmp / "files")
app = main.app

# Наименьший валидный PNG: одна прозрачная точка.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


def _token(c):
    body = {"login": "f_" + secrets.token_hex(4), "password": "secret123", "name": "F"}
    return c.post("/api/register", json=body).json()["token"]


def _upload(c, token, data=PNG, content_type="image/webp", name="pic"):
    return c.post(
        "/api/upload",
        params={"token": token},
        files={"file": (name, data, content_type)},
    )


# --- хранилище -------------------------------------------------------------

def test_saved_file_can_be_read_back():
    store = Files(Path(tempfile.mkdtemp()))
    saved = store.save(PNG, "image/png")
    assert store.path(saved["id"]).read_bytes() == PNG
    assert saved["size"] == len(PNG)


def test_identifiers_are_unique():
    store = Files(Path(tempfile.mkdtemp()))
    ids = {store.save(PNG, "image/png")["id"] for _ in range(20)}
    assert len(ids) == 20, "идентификаторы повторились"


def test_extension_follows_the_type():
    store = Files(Path(tempfile.mkdtemp()))
    assert store.save(PNG, "image/webp")["id"].endswith(".webp")
    assert store.save(PNG, "image/jpeg")["id"].endswith(".jpg")


def test_unknown_type_is_refused():
    store = Files(Path(tempfile.mkdtemp()))
    for bad in ("application/pdf", "text/html", "", "image/svg+xml"):
        try:
            store.save(PNG, bad)
        except FileError:
            continue
        raise AssertionError(f"принят чужой тип: {bad!r}")


def test_empty_and_oversized_files_are_refused():
    store = Files(Path(tempfile.mkdtemp()))
    for data in (b"", b"x" * (9 * 1024 * 1024)):
        try:
            store.save(data, "image/webp")
        except FileError:
            continue
        raise AssertionError("принят файл недопустимого размера")


def test_path_refuses_traversal():
    """Идентификатор приходит из URL — выйти за каталог по нему нельзя."""
    store = Files(Path(tempfile.mkdtemp()))
    for bad in ("../../etc/passwd", "..", "a/b", "a\\b", ""):
        assert store.path(bad) is None, f"путь вырвался наружу: {bad!r}"


def test_path_of_missing_file_is_none():
    store = Files(Path(tempfile.mkdtemp()))
    assert store.path("nosuchfile.webp") is None


# --- эндпоинты -------------------------------------------------------------

def test_upload_then_download_roundtrip():
    with TestClient(app) as c:
        token = _token(c)
        res = _upload(c, token)
        assert res.status_code == 200, res.text
        file_id = res.json()["id"]

        got = c.get(f"/api/file/{file_id}")
        assert got.status_code == 200
        assert got.content == PNG


def test_upload_requires_a_session():
    with TestClient(app) as c:
        assert _upload(c, "garbage").status_code == 401
        assert _upload(c, "").status_code == 401


def test_upload_refuses_foreign_types():
    with TestClient(app) as c:
        token = _token(c)
        res = _upload(c, token, data=b"%PDF-1.4", content_type="application/pdf")
        assert res.status_code == 400


def test_download_of_unknown_file_is_404():
    with TestClient(app) as c:
        assert c.get("/api/file/nosuchfile.webp").status_code == 404


def test_download_is_cached_forever():
    """Имя файла уникально, содержимое неизменно — можно кешировать надолго."""
    with TestClient(app) as c:
        file_id = _upload(c, _token(c)).json()["id"]
        got = c.get(f"/api/file/{file_id}")
        assert "immutable" in got.headers.get("cache-control", "")


def test_image_message_carries_only_the_identifier():
    """В журнал попадает ссылка, а не тело картинки."""
    with TestClient(app) as c:
        alice = c.post("/api/register", json={
            "login": "img_" + secrets.token_hex(4), "password": "secret123", "name": "A",
        }).json()
        bob = c.post("/api/register", json={
            "login": "img_" + secrets.token_hex(4), "password": "secret123", "name": "B",
        }).json()
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        file_id = _upload(c, alice["token"]).json()["id"]

        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": alice["token"], "cursors": {}})
            while ws.receive_json()["t"] != "synced":
                pass
            ws.send_json({"t": "tx", "txid": "i1", "doc": doc,
                          "op": "msg.image", "payload": {"file": file_id, "size": len(PNG)}})
            assert ws.receive_json()["t"] == "ack"

        row = main.db.entry_by_txid(doc, "i1")
        assert row["payload"]["file"] == file_id
        assert len(str(row["payload"])) < 200, "тело картинки утекло в журнал"


def test_transactions_carry_a_server_timestamp():
    """Время отправки берётся из транзакции, клиент его не присылает."""
    with TestClient(app) as c:
        alice = c.post("/api/register", json={
            "login": "ts_" + secrets.token_hex(4), "password": "secret123", "name": "A",
        }).json()
        bob = c.post("/api/register", json={
            "login": "ts_" + secrets.token_hex(4), "password": "secret123", "name": "B",
        }).json()
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])

        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "hello", "token": alice["token"], "cursors": {}})
            while ws.receive_json()["t"] != "synced":
                pass
            # Клиент присылает заведомо неверное время — сервер ставит своё.
            ws.send_json({"t": "tx", "txid": "t1", "doc": doc, "op": "msg.send",
                          "payload": {"text": "привет"}, "ts": 1})
            assert ws.receive_json()["t"] == "ack"

        row = main.db.entry_by_txid(doc, "t1")
        assert row["ts"] > 1_700_000_000_000, "серверное время не проставлено"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
