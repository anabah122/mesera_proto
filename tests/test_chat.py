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
import users as users_mod
from db import Database
from users import Users

main.db = Database(Path(tempfile.mkdtemp()) / "test.db")
main.users = Users(main.db)
app = main.app


def _user(c, tag="u"):
    body = {"login": f"{tag}_{secrets.token_hex(4)}", "password": "secret123", "name": tag, "invite": users_mod.INVITE}
    return c.post("/api/register", json=body).json()


def _sync(ws, token):
    ws.send_json({"t": "hello", "token": token, "cursors": {}})
    while ws.receive_json()["t"] != "synced":
        pass


def _recv(ws):
    """Следующий содержательный кадр.

    Присутствие рассылается всем при входе и выходе и приходит вперемежку
    с остальным; сценариям оно не интересно.
    """
    while True:
        frame = ws.receive_json()
        if frame["t"] != "presence":
            return frame


def _drain_until(ws, kind):
    """Кадры до указанного типа включительно — журнал состава едет тем же потоком.

    Досыл приходит пачкой evts; разворачиваем её в отдельные evt, как это
    делает настоящий клиент, чтобы сценарии читали поток записей единообразно.
    """
    out = []
    while True:
        f = ws.receive_json()
        if f["t"] == "presence":
            continue
        out.extend(_unpack(f))
        if f["t"] == kind:
            return out


def _unpack(frame):
    """Пачка evts — в отдельные записи; остальные кадры как есть."""
    if frame["t"] != "evts":
        return [frame]
    return [{"t": "evt", **entry} for entry in frame["entries"]]


def test_message_is_acked_with_an_index():
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
            ws.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "привет"}})
            f = _recv(ws)
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
            assert _recv(wa)["t"] == "ack"
            f = _recv(wb)
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
            assert _recv(wa)["t"] == "ack"

        with c.websocket_connect("/ws") as we:
            # Курсор по чужому диалогу игнорируется: досыл не приходит.
            we.send_json({"t": "hello", "token": eve["token"], "cursors": {doc: 0}})
            leaked = []
            while True:
                f = _recv(we)
                if f["t"] == "synced":
                    assert doc not in f["heads"], "чужой документ попал в heads"
                    break
                # Записи досыла лежат внутри пачки — разворачиваем, иначе
                # проверка по doc смотрела бы на конверт, а не на записи.
                leaked += [e for e in _unpack(f) if e.get("doc") == doc]
            assert not leaked, "утекла чужая переписка"

            # Запись тоже закрыта.
            we.send_json({"t": "tx", "txid": "x", "doc": doc,
                          "op": "msg.send", "payload": {"text": "врезка"}})
            assert _recv(we)["t"] == "nack"

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
                assert _recv(ws)["idx"] == 1
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
                _recv(wa)

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
                _recv(ws)
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
            f = _recv(ws)
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
                _recv(wa)
            _recv(wb)  # прилетело рассылкой

            # Сверяемся нулевым курсором — сервер досылает заново.
            wb.send_json({"t": "ping", "doc": doc, "idx": 0})
            got = [f["payload"]["text"] for f in _drain_until(wb, "pong") if f["t"] == "evt"]
            assert "текст" in got


def test_read_receipt_reaches_the_peer():
    """Отметка о прочтении — обычная транзакция: доезжает до собеседника."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])

            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "привет"}})
            assert _recv(wa)["t"] == "ack"
            assert _recv(wb)["op"] == "msg.send"

            # Боб отмечает прочитанным до первого сообщения.
            wb.send_json({"t": "tx", "txid": "r1", "doc": doc,
                          "op": "msg.read", "payload": {"upto": 1}})
            assert _recv(wb)["t"] == "ack"

            seen = _recv(wa)
            assert seen["op"] == "msg.read", "квитанция не дошла до автора"
            assert seen["author"] == bob["me"]["id"]
            assert seen["payload"]["upto"] == 1


def test_read_receipt_of_a_stranger_is_rejected():
    """В чужой диалог отметку о прочтении не записать."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        eve = _user(c, "eve")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as we:
            _sync(we, eve["token"])
            we.send_json({"t": "tx", "txid": "r", "doc": doc,
                          "op": "msg.read", "payload": {"upto": 1}})
            assert _recv(we)["t"] == "nack"


def test_delete_reaches_the_peer():
    """Удаление — обычная транзакция: доезжает до собеседника."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])

            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "привет"}})
            assert _recv(wa)["t"] == "ack"
            assert _recv(wb)["op"] == "msg.send"

            wa.send_json({"t": "tx", "txid": "d1", "doc": doc,
                          "op": "msg.delete", "payload": {"target": 1}})
            assert _recv(wa)["t"] == "ack"

            gone = _recv(wb)
            assert gone["op"] == "msg.delete"
            assert gone["payload"]["target"] == 1


def test_peer_cannot_delete_someone_elses_message():
    """Доступ к диалогу есть у обоих — но удаляет только автор."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])

            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "моё"}})
            assert _recv(wa)["t"] == "ack"
            _recv(wb)

            wb.send_json({"t": "tx", "txid": "d1", "doc": doc,
                          "op": "msg.delete", "payload": {"target": 1}})
            f = _recv(wb)
            assert f["t"] == "nack", "собеседник стёр чужое сообщение"
            assert not f["fatal"], "отказ не должен рвать сессию"


def test_delete_of_a_missing_message_is_rejected():
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
            ws.send_json({"t": "tx", "txid": "d", "doc": doc,
                          "op": "msg.delete", "payload": {"target": 999}})
            assert _recv(ws)["t"] == "nack"


def test_edit_reaches_the_peer():
    """Правка — обычная транзакция: доезжает до собеседника."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])

            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "было"}})
            assert _recv(wa)["t"] == "ack"
            assert _recv(wb)["op"] == "msg.send"

            wa.send_json({"t": "tx", "txid": "e1", "doc": doc,
                          "op": "msg.edit", "payload": {"target": 1, "text": "стало"}})
            assert _recv(wa)["t"] == "ack"

            edit = _recv(wb)
            assert edit["op"] == "msg.edit"
            assert edit["payload"] == {"target": 1, "text": "стало"}

            # Оригинал остаётся в журнале: правка кладётся отдельной записью.
            assert main.db.entry_at(doc, 1)["payload"]["text"] == "было"


def test_peer_cannot_edit_someone_elses_message():
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        doc = dialogs.dialog_id(alice["me"]["id"], bob["me"]["id"])
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])

            wa.send_json({"t": "tx", "txid": "m1", "doc": doc,
                          "op": "msg.send", "payload": {"text": "моё"}})
            assert _recv(wa)["t"] == "ack"
            _recv(wb)

            wb.send_json({"t": "tx", "txid": "e1", "doc": doc,
                          "op": "msg.edit", "payload": {"target": 1, "text": "чужое"}})
            f = _recv(wb)
            assert f["t"] == "nack", "собеседник изменил чужое сообщение"
            assert not f["fatal"], "отказ не должен рвать сессию"


def _await_presence(ws):
    """Ближайший кадр присутствия."""
    while True:
        frame = ws.receive_json()
        if frame["t"] == "presence":
            return frame


def test_presence_reaches_others_on_connect_and_disconnect():
    """Вход и выход видны остальным, в журнал при этом ничего не пишется."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        with c.websocket_connect("/ws") as wa:
            _sync(wa, alice["token"])
            head = main.db.last_idx(dialogs.DOC_USERS)

            with c.websocket_connect("/ws") as wb:
                _sync(wb, bob["token"])
                came = _await_presence(wa)
                assert came["id"] == bob["me"]["id"]
                assert came["online"] is True

            gone = _await_presence(wa)
            assert gone["id"] == bob["me"]["id"]
            assert gone["online"] is False
            assert gone["last_seen"] > 0, "время ухода не проставлено"

        # Присутствие эфемерно: журнал состава от него не растёт.
        assert main.db.last_idx(dialogs.DOC_USERS) == head


def test_ready_carries_the_online_snapshot():
    """Подключившийся сразу знает, кто в сети: чужого входа он не застал."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        with c.websocket_connect("/ws") as wa:
            _sync(wa, alice["token"])
            with c.websocket_connect("/ws") as wb:
                wb.send_json({"t": "hello", "token": bob["token"], "cursors": {}})
                ready = wb.receive_json()
                assert ready["t"] == "ready"
                assert alice["me"]["id"] in ready["online"]


def test_background_tab_is_not_online():
    """Свёрнутая вкладка присутствием не считается."""
    with TestClient(app) as c:
        alice, bob = _user(c, "alice"), _user(c, "bob")
        with c.websocket_connect("/ws") as wa, c.websocket_connect("/ws") as wb:
            _sync(wa, alice["token"])
            _sync(wb, bob["token"])
            _await_presence(wa)  # Боб вошёл

            wb.send_json({"t": "ping", "active": False})
            gone = _await_presence(wa)
            assert gone["online"] is False, "фоновая вкладка осталась в сети"

            wb.send_json({"t": "ping", "active": True})
            back = _await_presence(wa)
            assert back["online"] is True, "возврат на вкладку не вернул в сеть"


def test_last_seen_survives_the_disconnect():
    """Ушедшего видно по last_seen в составе."""
    with TestClient(app) as c:
        alice = _user(c, "alice")
        with c.websocket_connect("/ws") as ws:
            _sync(ws, alice["token"])
        seen = main.users.by_id(alice["me"]["id"])["last_seen"]
        assert seen > 0, "время последнего визита не записано"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
