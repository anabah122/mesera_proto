"""Хранилище вложений.

Файл лежит на диске, а не в журнале: в транзакцию попадает только его
идентификатор. Крупные тела мимо сокета — иначе одна картинка забьёт
канал, за которым стоят живые сообщения.

Имя файла — случайные 32 символа. Скачивание не проверяет права:
угадать имя нельзя, а проверка на каждой картинке в ленте стоила бы
токена в каждом <img>.
"""

import secrets
from pathlib import Path

# Что принимаем. Клиент жмёт картинку в WebP через canvas, но старые
# браузеры этого не умеют и присылают JPEG — оба варианта нормальны.
TYPES = {
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
}

# Клиент ужимает картинку до ~250 КБ. Предел с запасом: он защищает от
# заведомо чужого запроса, а не подгоняет размер.
MAX_BYTES = 8 * 1024 * 1024


class FileError(Exception):
    """Ошибка, которую можно показать пользователю."""


class Files:
    def __init__(self, root: Path):
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def save(self, data: bytes, content_type: str) -> dict:
        """Кладёт файл на диск и возвращает его описание для транзакции."""
        ext = TYPES.get(content_type)
        if not ext:
            raise FileError("неподдерживаемый тип файла")
        if not data:
            raise FileError("пустой файл")
        if len(data) > MAX_BYTES:
            raise FileError("файл больше 8 МБ")

        file_id = secrets.token_urlsafe(24) + ext
        (self._root / file_id).write_bytes(data)
        return {"id": file_id, "size": len(data), "type": content_type}

    def path(self, file_id: str) -> Path | None:
        """Путь к файлу по идентификатору, если тот существует.

        Идентификатор приходит из URL, поэтому проверяется на попытку
        выйти за пределы каталога.
        """
        if not file_id or "/" in file_id or "\\" in file_id or ".." in file_id:
            return None
        path = self._root / file_id
        return path if path.is_file() else None
