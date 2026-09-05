# mesera_proto

Прототип мессенджера на транзакционном WebSocket.

## Запуск

Локально:

    run.bat

В Docker:

    docker compose up --build

Локально — http://127.0.0.1:8100 (run.bat), в контейнере — http://localhost
(наружу отдаётся стандартный 80-й порт).

## Проверка

    python tests/run_tests.py

Отдельный модуль — `python tests/test_chat.py`. Клиентские тесты идут через
node и пропускаются, если его нет.

## Устройство

- `backend/` — FastAPI: HTTP для входа, WebSocket для транзакций, SQLite для журналов
- `frontend/` — голый JS: IndexedDB для локальных журналов, модули без сборки
- `tests/` — тесты, запуск через `tests/run_tests.py`
- `docs/protocol.html` — спецификация протокола chat.v1
- `DECISIONS.md` — принятые решения и причины

## Страницы

- `/` — вход и регистрация, только HTTP
- `/chat` — чат, только WebSocket и IndexedDB

## Переменные

- `MESERA_DB` — путь к базе. В контейнере `/data/mesera.db` на томе, локально рядом с кодом.
