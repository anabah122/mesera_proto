"""Прогон всех тестов одной командой: python tests/run_tests.py

Каждый модуль запускается своим процессом: тесты подменяют главный
объект приложения, и общий интерпретатор дал бы им влиять друг на друга.
Клиентские тесты идут через node, если он есть в системе.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    runs = [(p.name, [sys.executable, p.name]) for p in sorted(ROOT.glob("test_*.py"))]

    node = shutil.which("node")
    if node:
        runs += [(p.name, [node, p.name]) for p in sorted(ROOT.glob("test_*.mjs"))]

    failed = []
    for name, cmd in runs:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        tail = (proc.stdout or proc.stderr or "").strip().splitlines()
        print(f"{name:<24} {tail[-1] if tail else '(нет вывода)'}")
        if proc.returncode != 0:
            failed.append((name, proc.stdout + proc.stderr))

    if not node:
        print("node не найден — клиентские тесты пропущены")

    print("-" * 46)
    if failed:
        for name, output in failed:
            print(f"\n=== {name} ===\n{output.strip()}")
        print(f"\nпровалено: {len(failed)} из {len(runs)}")
        return 1

    print(f"все модули прошли: {len(runs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
