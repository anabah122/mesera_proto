FROM python:3.13-slim

# Не писать .pyc и не буферизовать вывод: логи видны в docker logs сразу.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Зависимости отдельным слоем: правки кода не пересобирают pip install.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

# База лежит на томе, а не в слое образа — иначе переживёт только до пересборки.
ENV MESERA_DB=/data/mesera.db
RUN mkdir -p /data && useradd -r -u 10001 mesera && chown -R mesera /data
USER mesera

WORKDIR /app/backend
EXPOSE 8100

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
