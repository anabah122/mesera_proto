"""Переписка: доставка, изоляция, дедупликация, история.

Сценарии целиком через протокол — так же, как их видит браузер.
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
from db import Database
from users import Users

main.db = Database(Path(tempfile.mkdtemp()) / "test.db")
main.users = Users(main.db)
app = main.app


def _user(c, tag="u"):
    body = {"login": f"{tag}_{secrets.token_hex(4)}", "password": "secret123", "name": tag}
    return c.post("/api/register", json=body).json()


def _sync(ws, token):
    ws.send_json({"t": "hello", "token": token, "cursors": {}})
    while ws.receive_json()["t"] != "synced":
        pass


def _drain_until(ws, kind):
    """Кадры до указанного типа включительно — журнал состава едет тем же потоком."""
    out = []
    while True:
        f = ws.receive_json()
        out.append(f)
        if f["t"] == kind:
            return out


def test_message_is_acked_with_an_index():
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
            ws.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "привет"}})
            f = ws.receive_json()
            assert f["t"] == "ack" and f["txid"] == "m1" and f["idx"] == 1


def test_message_reaches_the_other_side_live():
    """Собеседник получает сообщение, не переподключаясь."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])
            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "привет"}})
            assert wa.receive_json()["t"] == "ack"
            f = wb.receive_json()
            assert f["t"] == "evt" and f["payload"]["text"] == "привет"
            assert f["author"] == alice["me"]["id"]


def test_author_other_tab_also_receives_the_message():
    """Вторая вкладка автора должна увидеть отправленное."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as tab1, c.websocket_connect("/ws") as tab2:
            _sync(tab1, alice["token"])
            _sync(tab2, alice["token"])
            tab1.send_json({"t": "tx", "txid": "m1", "doc": doc,
                            "op": "msg.send", "payload": {"text": "с другой вкладки"}})
            assert tab1.receive_json()["t"] == "ack"
            f = tab2.receive_json()
            assert f["t"] == "evt" and f["payload"]["text"] == "с другой вкладки"


def test_outsider_cannot_read_or_write_someone_elses_dialog():
    """Ключевая проверка приватности."""
    with TestClient(app) as c:
        alice, bob, eve = _user(c, "alice"), _user(c, "bob"), _user(c, "eve")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa:
            _sync(wa, alice["token"])
            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "секрет"}})
            assert wa.receive_json()["t"] == "ack"

        with c.websocket_connect("/ws") as we:
            # Курсор по чужому диалогу игнорируется: досыл не приходит.
            we.send_json({"t": "hello", "token": eve["token"], "cursors": {doc: 0}})
            leaked = []
            while True:
                f = we.receive_json()
                if f["t"] == "synced":
                    assert doc not in f["heads"], "чужой документ попал в heads"
                    break
                if f.get("doc") == doc:
                    leaked.append(f)
            assert not leaked, "утекла чужая переписка"

            # Запись тоже закрыта.
            we.send_json({"t": "tx", "txid": "x", "doc": doc,
                          "op": "msg.send", "payload": {"text": "врезка"}})
            assert we.receive_json()["t"] == "nack"

            # И добор истории: на fetch не должно прийти ни одной записи.
            we.send_json({"t": "fetch", "doc": doc, "before": 0, "limit": 10})
            we.send_json({"t": "ping"})
            frames = _drain_until(we, "pong")
            assert not [f for f in frames if f["t"] == "evt"], "fetch выдал чужое"


def test_resent_txid_does_not_duplicate_the_message():
    """Повтор после обрыва не должен задвоить сообщение в ленте."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
            for _ in range(2):
                ws.send_json({"t": "tx", "txid": "same", "doc": doc,
                              "op": "msg.send", "payload": {"text": "раз"}})
                assert ws.receive_json()["idx"] == 1
            ws.send_json({"t": "fetch", "doc": doc, "before": 0, "limit": 50})
            ws.send_json({"t": "ping"})
            got = [f for f in _drain_until(ws, "pong") if f["t"] == "evt"]
            assert len(got) == 1, f"сообщение задвоилось: {len(got)}"


def test_offline_side_catches_up_by_cursor():
    """Пропущенное во время оффлайна приходит досылом на HELLO."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa:
            _sync(wa, alice["token"])
            for i in range(3):
                wa.send_json({"t": "tx", "txid": f"m{i}", "doc": doc,
                              "op": "msg.send", "payload": {"text": f"#{i}"}})
                wa.receive_json()

        with c.websocket_connect("/ws") as wb:
            wb.send_json({"t": "hello", "token": bob["token"], "cursors": {doc: 1}})
            got = [f["payload"]["text"] for f in _drain_until(wb, "synced")
                   if f["t"] == "evt" and f["doc"] == doc]
            assert got == ["#1", "#2"], f"досыл по курсору неверен: {got}"


def test_fetch_returns_history_window():
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
            for i in range(5):
                ws.send_json({"t": "tx", "txid": f"m{i}", "doc": doc,
                              "op": "msg.send", "payload": {"text": f"#{i}"}})
                ws.receive_json()
            ws.send_json({"t": "fetch", "doc": doc, "before": 4, "limit": 2})
            ws.send_json({"t": "ping"})
            idx = [f["idx"] for f in _drain_until(ws, "pong") if f["t"] == "evt"]
            assert idx == [2, 3], f"окно истории неверно: {idx}"


def test_frames_before_hello_are_refused():
    """Без сессии не проходит ничего, кроме ping и hello."""
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"t": "tx", "txid": "m", "doc": "d:a:b",
                          "op": "msg.send", "payload": {}})
            f = ws.receive_json()
            assert f["t"] == "nack" and not f["fatal"]


def test_heartbeat_delivers_missed_dialog_messages():
    """PING с курсором диалога досылает пропущенное без переподключения."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wb:
            _sync(wb, bob["token"])
            with c.websocket_connect("/ws") as wa:
                _sync(wa, alice["token"])
                wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                              "op": "msg.send", "payload": {"text": "текст"}})
                wa.receive_json()
            wb.receive_json()  # прилетело рассылкой

            # Сверяемся нулевым курсором — сервер досылает заново.
            wb.send_json({"t": "ping", "doc": doc, "idx": 0})
            got = [f["payload"]["text"] for f in _drain_until(wb, "pong") if f["t"] == "evt"]
            assert "текст" in got


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
