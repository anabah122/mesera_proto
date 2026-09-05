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
RESET = "reset"
PONG = "pong"


def ready(me: dict, users: list[dict]) -> dict:
    """Сессия принята: кто я и кого видно."""
    return {"t": READY, "me": me, "users": users}


def synced(heads: dict[str, int]) -> dict:
    """Досыл окончен. heads — номер головы каждого документа."""
    return {"t": SYNCED, "heads": heads}


def ack(txid: str, doc: str, idx: int) -> dict:
    return {"t": ACK, "txid": txid, "doc": doc, "idx": idx}


def nack(txid: str, reason: str) -> dict:
    return {"t": NACK, "txid": txid, "reason": reason}


def evt(entry: dict) -> dict:
    return {"t": EVT, **entry}


def reset(doc: str, head: int) -> dict:
    """Разрыв больше окна — журнал документа пересобрать с нуля."""
    return {"t": RESET, "doc": doc, "head": head}


def pong() -> dict:
    return {"t": PONG}
