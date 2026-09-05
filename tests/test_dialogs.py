"""Идентификаторы диалогов и права доступа.

can_read/can_write — единственная преграда между чужой перепиской и
клиентом, поэтому проверяется и то, что разрешено, и то, что закрыто.
"""

import sys
from pathlib import Path

# Тесты живут отдельно от кода — добавляем backend/ в путь импорта.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import dialogs as d

A, B, C = "u_aaa", "u_bbb", "u_ccc"


def test_dialog_id_is_order_independent():
    """Пара всегда даёт один идентификатор — кто первым написал, неважно."""
    assert d.dialog_id(A, B) == d.dialog_id(B, A)


def test_dialog_id_is_sorted_and_prefixed():
    assert d.dialog_id(B, A) == f"d:{A}:{B}"


def test_different_pairs_give_different_ids():
    assert len({d.dialog_id(A, B), d.dialog_id(A, C), d.dialog_id(B, C)}) == 3


def test_members_roundtrip():
    assert set(d.members(d.dialog_id(A, B))) == {A, B}


def test_peer_returns_the_other_side():
    doc = d.dialog_id(A, B)
    assert d.peer(doc, A) == B
    assert d.peer(doc, B) == A


def test_is_dialog_rejects_foreign_shapes():
    assert d.is_dialog(d.dialog_id(A, B))
    for bad in ("users", "", "d:", "d:only_one", "x:a:b", "d:a:b:c"):
        assert not d.is_dialog(bad), f"опознан как диалог: {bad!r}"


# --- права -----------------------------------------------------------------

def test_participants_read_and_write_their_dialog():
    doc = d.dialog_id(A, B)
    for user in (A, B):
        assert d.can_read(doc, user)
        assert d.can_write(doc, user)


def test_outsider_is_shut_out_of_a_dialog():
    """Главное правило: чужая переписка недоступна ни на чтение, ни на запись."""
    doc = d.dialog_id(A, B)
    assert not d.can_read(doc, C)
    assert not d.can_write(doc, C)


def test_users_journal_is_readable_by_all_and_writable_by_none():
    for user in (A, B, C):
        assert d.can_read(d.DOC_USERS, user), "состав системы виден всем"
        assert not d.can_write(d.DOC_USERS, user), "в журнал состава пишет только сервер"


def test_unknown_documents_are_closed():
    for doc in ("", "secret", "d:", "../users", "d:a:b:c"):
        assert not d.can_read(doc, A), f"открыт лишний документ: {doc!r}"
        assert not d.can_write(doc, A), f"разрешена запись в: {doc!r}"


def test_prefix_lookalike_does_not_grant_access():
    """Похожий на свой идентификатор не должен пускать в чужой диалог."""
    assert not d.can_read("d:" + A + ":" + B + ":extra", A)
    assert not d.can_read("dd:" + A + ":" + B, A)


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"ok ({len(TESTS)})")
