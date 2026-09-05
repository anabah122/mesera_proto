# mesera_proto

Прототип мессенджера на транзакционном WebSocket.

## Запуск

    run.bat

Открыть http://127.0.0.1:8100

## Устройство

- `backend/` — FastAPI: HTTP для входа, WebSocket для транзакций, SQLite для журналов
- `frontend/` — голый JS: IndexedDB для локальных журналов, модули без сборки
- `docs/protocol.html` — спецификация протокола chat.v1
- `DECISIONS.md` — принятые решения и причины
