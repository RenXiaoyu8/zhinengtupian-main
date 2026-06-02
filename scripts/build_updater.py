from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = PROJECT_ROOT / "updater.spec"
BUILD_DIR = PROJECT_ROOT / "build"
TARGET_EXE = BUILD_DIR / "updater.exe"


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    if not SPEC_PATH.exists():
        raise SystemExit(f"updater.spec not found: {SPEC_PATH}")

    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    print("Building updater.exe...")
    build_cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", str(SPEC_PATH)]
    result = subprocess.run(build_cmd, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        print("PyInstaller build failed, trying to install/repair PyInstaller...")
        run([sys.executable, "-m", "pip", "install", "pyinstaller"])
        run(build_cmd)

    candidates = [
        PROJECT_ROOT / "dist" / "updater.exe",
        PROJECT_ROOT / "dist" / "updater" / "updater.exe",
    ]
    built_exe = next((p for p in candidates if p.exists()), None)
    if not built_exe:
        raise SystemExit("updater.exe was not generated.")

    shutil.copy2(built_exe, TARGET_EXE)
    print(f"Generated: {TARGET_EXE}")


if __name__ == "__main__":
    main()
