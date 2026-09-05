@echo off
cd /d "%~dp0backend"
python -m pip install -q -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8100 --reload
