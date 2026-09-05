"""Диалоги.

Идентификатор диалога составлен из двух идентификаторов пользователей,
отсортированных лексикографически. Пара всегда даёт один и тот же
идентификатор независимо от того, кто пишет первым, поэтому отдельной
записи о создании диалога не нужно: первая транзакция и есть его начало.
"""

DOC_USERS = "users"


def dialog_id(a: str, b: str) -> str:
    left, right = sorted((a, b))
    return f"d:{left}:{right}"


def members(doc: str) -> tuple[str, str]:
    _, left, right = doc.split(":", 2)
    return left, right


def is_dialog(doc: str) -> bool:
    return doc.startswith("d:") and doc.count(":") == 2


def is_member(doc: str, user_id: str) -> bool:
    return is_dialog(doc) and user_id in members(doc)


def peer(doc: str, user_id: str) -> str:
    left, right = members(doc)
    return right if user_id == left else left
