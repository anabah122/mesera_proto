"""Точка входа: HTTP для входа в систему, WebSocket для всего остального."""

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import dialogs
import protocol as p
from db import Database
from files import FileError, Files
from hub import Hub
from session import Session
from users import UserError, Users

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT.parent / "frontend"
# В контейнере база лежит на томе; локально — рядом с кодом.
DB_PATH = Path(os.environ.get("MESERA_DB") or ROOT / "mesera.db")
# Вложения лежат рядом с базой: тот же том переживает пересборку образа.
FILES_PATH = Path(os.environ.get("MESERA_FILES") or DB_PATH.parent / "files")

app = FastAPI()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
db = Database(DB_PATH)
users = Users(db)
files = Files(FILES_PATH)
hub = Hub()


# Пользователи, заведённые до появления журнала состава, получают свои
# записи при старте — иначе клиент их не увидит.
users.backfill()


class Credentials(BaseModel):
    login: str
    password: str
    name: str = ""


@app.post("/api/register")
async def register(body: Credentials):
    try:
        user = users.register(body.login, body.password, body.name)
    except UserError as e:
        raise HTTPException(400, str(e))
    # Появление пользователя — такая же транзакция, как сообщение: она ложится
    # в журнал состава и тем же кадром EVT уходит всем открытым вкладкам.
    entry = users.log_add(user)
    await hub.broadcast(p.evt(entry))
    return {"token": users.open_session(user["id"]), "me": user}


@app.post("/api/login")
def login(body: Credentials):
    try:
        user = users.login(body.login, body.password)
    except UserError as e:
        raise HTTPException(401, str(e))
    return {"token": users.open_session(user["id"]), "me": user}


@app.post("/api/upload")
async def upload(file: UploadFile, token: str = ""):
    """Приём вложения. Тело идёт мимо сокета, в журнал попадёт только id."""
    if not users.by_token(token):
        raise HTTPException(401, "нужна сессия")
    try:
        saved = files.save(await file.read(), file.content_type or "")
    except FileError as e:
        raise HTTPException(400, str(e))
    return saved


@app.get("/api/file/{file_id}")
def download(file_id: str):
    """Отдача вложения. Имя случайное, поэтому прав не проверяем."""
    path = files.path(file_id)
    if not path:
        raise HTTPException(404, "файл не найден")
    # Содержимое неизменяемо: имя файла уникально, поэтому кешируем надолго.
    return FileResponse(path, headers={"cache-control": "public, max-age=31536000, immutable"})


@app.get("/")
def page_login():
    """Страница входа: только форма, никакого сокета."""
    return _page("index.html")


@app.get("/chat")
def page_chat():
    """Страница чата. Токен проверяется на HELLO, без него клиент уйдёт на вход."""
    return _page("chat.html")


def _page(name: str) -> FileResponse:
    # Разметку не кешируем: иначе браузер держит старую версию страницы
    # и не видит обновлённых ссылок на скрипты.
    return FileResponse(FRONTEND / name, headers={"cache-control": "no-cache"})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session(ws, db, users, hub)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                frame = json.loads(raw)
            except ValueError:
                # Кривой кадр — не повод рвать соединение.
                await ws.send_json(p.nack("", "кадр не разобран"))
                continue
            if not isinstance(frame, dict):
                await ws.send_json(p.nack("", "кадр не является объектом"))
                continue
            if not await session.handle(frame):
                break
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
