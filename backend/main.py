"""Точка входа: HTTP для входа в систему, WebSocket для всего остального."""

from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db import Database
from hub import Hub
from session import Session
from users import UserError, Users

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT.parent / "frontend"

app = FastAPI()
db = Database(ROOT / "mesera.db")
users = Users(db)
hub = Hub()


class Credentials(BaseModel):
    login: str
    password: str
    name: str = ""


@app.post("/api/register")
def register(body: Credentials):
    try:
        user = users.register(body.login, body.password, body.name)
    except UserError as e:
        raise HTTPException(400, str(e))
    return {"token": users.open_session(user["id"]), "me": user}


@app.post("/api/login")
def login(body: Credentials):
    try:
        user = users.login(body.login, body.password)
    except UserError as e:
        raise HTTPException(401, str(e))
    return {"token": users.open_session(user["id"]), "me": user}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session(ws, db, users, hub)
    try:
        while True:
            await session.handle(await ws.receive_json())
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
