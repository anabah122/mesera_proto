"""Кадры протокола chat.v1.

Кадр — объект с полем "t". Каждая транзакция принадлежит документу,
номера idx локальны внутри документа.
"""

# клиент -> сервер
HELLO = "hello"
TX = "tx"
FETCH = "fetch"
PING = "ping"

# сервер -> клиент
READY = "ready"
SYNCED = "synced"
ACK = "ack"
NACK = "nack"
EVT = "evt"
EVTS = "evts"
RESET = "reset"
PONG = "pong"
PRESENCE = "presence"


def ready(me: dict, users: list[dict], online: list[str]) -> dict:
    """Сессия принята: кто я, кого видно и кто сейчас в сети."""
    return {"t": READY, "me": me, "users": users, "online": online}


def presence(user_id: str, online: bool, last_seen: int = 0) -> dict:
    """Кто-то вошёл или вышел.

    В журнал это не пишется: присутствие живёт секунды, а журнал —
    навсегда. Клиент, который его не застал, получит снимок в READY.
    """
    return {"t": PRESENCE, "id": user_id, "online": online, "last_seen": last_seen}


def synced(heads: dict[str, int]) -> dict:
    """Досыл окончен. heads — номер головы каждого документа."""
    return {"t": SYNCED, "heads": heads}


def ack(txid: str, doc: str, idx: int) -> dict:
    return {"t": ACK, "txid": txid, "doc": doc, "idx": idx}


def nack(txid: str, reason: str, fatal: bool = False) -> dict:
    """Отказ. fatal — отвергнута сессия целиком, а не отдельная транзакция."""
    return {"t": NACK, "txid": txid, "reason": reason, "fatal": fatal}


def evt(entry: dict) -> dict:
    """Одна запись журнала: живое сообщение, пришедшее прямо сейчас."""
    return {"t": EVT, **entry}


def evts(entries: list[dict]) -> dict:
    """Пачка записей одним кадром — досыл истории.

    Досыл после долгого разрыва — это сотни записей. Поштучная отправка
    заставляет клиента ждать, пока они промотаются по одной, поэтому
    накопленное уходит одним кадром.
    """
    return {"t": EVTS, "entries": entries}


def reset(doc: str, head: int) -> dict:
    """Разрыв больше окна — журнал документа пересобрать с нуля."""
    return {"t": RESET, "doc": doc, "head": head}


def pong(ts: int = 0) -> dict:
    """Серверное время: клиент сверяет по нему курсор общих действий."""
    return {"t": PONG, "ts": ts}
