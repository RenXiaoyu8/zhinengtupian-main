from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_JSON = PROJECT_ROOT / "package.json"
UPDATE_CONFIG = PROJECT_ROOT / "update_config.json"
RELEASE_ROOT = PROJECT_ROOT / "release"
APP_DIR = RELEASE_ROOT / "ShangpinCloudAssets"
APP_DIR_FALLBACK = RELEASE_ROOT / "win-unpacked"
RELEASES_DIR = PROJECT_ROOT / "releases"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def get_npm_cmd() -> str:
    return "npm.cmd" if sys.platform.startswith("win") else "npm"


def zip_dir(source_dir: Path, zip_path: Path, root_name: str | None = None) -> None:
    if zip_path.exists():
        zip_path.unlink()
    files = [file for file in source_dir.rglob("*") if file.is_file()]
    total = len(files)
    total_bytes = sum(file.stat().st_size for file in files)
    written_bytes = 0
    print(f"Files to compress: {total}, size: {total_bytes / 1024 / 1024:.1f} MB", flush=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for idx, file in enumerate(files, 1):
            arcname = file.relative_to(source_dir.parent)
            if root_name:
                arcname = Path(root_name) / file.relative_to(source_dir)
            zf.write(file, arcname)
            written_bytes += file.stat().st_size
            if idx == total or idx % 500 == 0:
                pct = (written_bytes / total_bytes * 100) if total_bytes else 100
                print(f"  compressed {idx}/{total} files ({pct:.1f}%)", flush=True)


def normalize_app_dir() -> Path:
    if APP_DIR_FALLBACK.exists():
        if APP_DIR.exists():
            shutil.rmtree(APP_DIR)
        try:
            APP_DIR_FALLBACK.rename(APP_DIR)
        except PermissionError:
            print(f"Warning: could not rename {APP_DIR_FALLBACK.name} to {APP_DIR.name}; packaging it with the expected zip root instead.")
            return APP_DIR_FALLBACK
    if APP_DIR.exists():
        return APP_DIR
    raise SystemExit(f"App directory not found after build: {APP_DIR}")


def copy_backend_runtime(app_dir: Path) -> None:
    electron_dir = app_dir / "electron"
    electron_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PROJECT_ROOT / "electron" / "server-bundle.cjs", electron_dir / "server-bundle.cjs")
    shutil.copy2(PACKAGE_JSON, app_dir / "package.json")

    modules = [
        "better-sqlite3",
        "bindings",
        "file-uri-to-path",
        "sharp",
        "@img",
        "canvas",
    ]
    dst_node_modules = app_dir / "node_modules"
    dst_node_modules.mkdir(parents=True, exist_ok=True)
    for name in modules:
        src = PROJECT_ROOT / "node_modules" / name
        if not src.exists():
            continue
        dst = dst_node_modules / name
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

    binding_sources = [
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "build" / "Release" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "build" / "Debug" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "build" / "default" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "compiled" / "24.14.0" / "win32" / "x64" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "addon-build" / "release" / "install-root" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "addon-build" / "debug" / "install-root" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "addon-build" / "default" / "install-root" / "better_sqlite3.node",
        PROJECT_ROOT / "node_modules" / "better-sqlite3" / "lib" / "binding" / "node-v137-win32-x64" / "better_sqlite3.node",
    ]
    binding_dst_dirs = [
        dst_node_modules / "better-sqlite3" / "build" / "Release",
        dst_node_modules / "better-sqlite3" / "build" / "Debug",
        dst_node_modules / "better-sqlite3" / "build" / "default",
        dst_node_modules / "better-sqlite3" / "compiled" / "24.14.0" / "win32" / "x64",
        dst_node_modules / "better-sqlite3" / "addon-build" / "release" / "install-root",
        dst_node_modules / "better-sqlite3" / "addon-build" / "debug" / "install-root",
        dst_node_modules / "better-sqlite3" / "addon-build" / "default" / "install-root",
        dst_node_modules / "better-sqlite3" / "lib" / "binding" / "node-v137-win32-x64",
    ]
    for src, dst_dir in zip(binding_sources, binding_dst_dirs):
        if not src.exists():
          continue
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst_dir / "better_sqlite3.node")


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish portable release package")
    parser.add_argument("--version", dest="version", default="", help="release version")
    parser.add_argument("--release-notes", dest="release_notes", default="", help="release notes")
    args = parser.parse_args()

    if not PACKAGE_JSON.exists():
        raise SystemExit(f"package.json not found: {PACKAGE_JSON}")
    if not UPDATE_CONFIG.exists():
        raise SystemExit(f"update_config.json not found: {UPDATE_CONFIG}")

    pkg = read_json(PACKAGE_JSON)
    current_version = str(pkg.get("version", "1.0.0"))

    version_prompt = (
        f"Input new version (current: {current_version}, example: 1.0.6): "
        if not args.version
        else args.version
    )
    version = (args.version or input(version_prompt)).strip()
    if not version:
        raise SystemExit("Version is required.")

    release_notes = (args.release_notes or input("Input release notes (optional): ")).strip() or f"Updated to version {version}: fixes and improvements."

    pkg["version"] = version
    write_json(PACKAGE_JSON, pkg)

    print("Running electron build...")
    run([get_npm_cmd(), "run", "electron:build"])

    app_dir = normalize_app_dir()
    copy_backend_runtime(app_dir)

    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    zip_name = f"shangpin-cloud-assets-{version}.zip"
    zip_path = RELEASES_DIR / zip_name

    print(f"Compressing app dir to: {zip_path}")
    zip_dir(app_dir, zip_path, APP_DIR.name if app_dir == APP_DIR_FALLBACK else None)

    cfg = read_json(UPDATE_CONFIG)
    cfg["version"] = version
    cfg["fileName"] = zip_name
    cfg["releaseNotes"] = release_notes
    write_json(UPDATE_CONFIG, cfg)

    public_base_url = str(cfg.get("publicBaseUrl", "")).rstrip("/")
    print("\nPublish complete.")
    print(f"Version: {version}")
    print(f"Package: {zip_path}")
    if public_base_url:
        print(f"Download URL: {public_base_url}/releases/{zip_name}")
    else:
        print("Note: publicBaseUrl is empty. Please verify clients can access /releases manually.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Publish cancelled.")
