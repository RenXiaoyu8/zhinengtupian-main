from __future__ import annotations

import argparse
import json
import os
import tempfile
import shutil
import subprocess
import sys
import time
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


def replace_when_available(source: Path, destination: Path) -> None:
    deadline = time.monotonic() + 45
    delay = 0.25
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            remaining = deadline - time.monotonic()
            # Replacing an open destination can also yield ERROR_ACCESS_DENIED.
            if getattr(error, "winerror", None) not in (5, 32, 33) or remaining <= 0:
                raise
            if delay == 0.25:
                print(f"Windows cannot replace {destination.name} yet; retrying...", flush=True)
            time.sleep(min(delay, remaining))
            delay = min(delay * 2, 2)


def discard_temp(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        print(f"Temporary file retained: {path} ({error})", file=sys.stderr)


def write_json(path: Path, data: dict) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        replace_when_available(temp, path)
    finally:
        discard_temp(temp)


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def get_npm_cmd() -> str:
    return "npm.cmd" if sys.platform.startswith("win") else "npm"


def zip_dir(source_dir: Path, zip_path: Path, root_name: str | None = None) -> None:
    files = [file for file in source_dir.rglob("*") if file.is_file()]
    total = len(files)
    total_bytes = sum(file.stat().st_size for file in files)
    written_bytes = 0
    print(f"Files to compress: {total}, size: {total_bytes / 1024 / 1024:.1f} MB", flush=True)
    # Serve the previous complete archive until the new zip has a valid central directory and CRCs.
    with tempfile.NamedTemporaryFile(dir=zip_path.parent, suffix=".part", delete=False) as stream:
        pending = Path(stream.name)
    try:
        with zipfile.ZipFile(pending, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, file in enumerate(files, 1):
                arcname = file.relative_to(source_dir.parent)
                if root_name:
                    arcname = Path(root_name) / file.relative_to(source_dir)
                zf.write(file, arcname)
                written_bytes += file.stat().st_size
                if idx == total or idx % 500 == 0:
                    pct = (written_bytes / total_bytes * 100) if total_bytes else 100
                    print(f"  compressed {idx}/{total} files ({pct:.1f}%)", flush=True)
        with zipfile.ZipFile(pending) as archive:
            failed = archive.testzip()
            if failed:
                raise ValueError(f"ZIP verification failed for {failed}")
    except BaseException:
        discard_temp(pending)
        raise
    install_archive(pending, zip_path)


def install_archive(pending: Path, zip_path: Path) -> None:
    try:
        replace_when_available(pending, zip_path)
    except OSError:
        print(f"Verified archive retained at {pending}. Resume with:", file=sys.stderr)
        print(f'  python scripts/publish_release.py --resume-archive "{pending}"', file=sys.stderr)
        raise



def normalize_app_dir() -> Path:
    if APP_DIR_FALLBACK.exists():
        if APP_DIR.exists():
            if APP_DIR.resolve() != RELEASE_ROOT.resolve() / "ShangpinCloudAssets":
                raise ValueError(f"Unexpected release directory: {APP_DIR}")
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

    shutil.copytree(PROJECT_ROOT / "dist", app_dir / "dist", dirs_exist_ok=True, ignore=shutil.ignore_patterns("updater.exe"))
    modules = [
        "better-sqlite3",
        "bindings",
        "file-uri-to-path",
        "sharp",
        "@img",
        "detect-libc",
        "semver",
        "canvas",
        "ffmpeg-static",
    ]
    dst_node_modules = app_dir / "node_modules"
    dst_node_modules.mkdir(parents=True, exist_ok=True)
    for name in modules:
        src = PROJECT_ROOT / "node_modules" / name
        if not src.exists():
            continue
        dst = dst_node_modules / name
        if dst.exists():
            if dst.resolve().parent != dst_node_modules.resolve() or dst.is_symlink():
                raise ValueError(f"Unexpected module destination: {dst}")
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

    # Reject missing dependencies even if Node could find them in the enclosing workspace.
    check = """
        const path = require('path');
        const root = require('fs').realpathSync('node_modules') + path.sep;
        require('sharp');
        new (require('better-sqlite3'))(':memory:').close();
        for (const file of Object.keys(require.cache)) {
            if (!file.startsWith(root)) throw Error('Dependency outside package: ' + file);
        }
    """
    subprocess.run(["node", "-e", check], cwd=app_dir, check=True)



def main() -> None:
    parser = argparse.ArgumentParser(description="Publish portable release package")
    parser.add_argument("--version", dest="version", default="", help="release version")
    parser.add_argument("--release-notes", dest="release_notes", default="", help="release notes")
    parser.add_argument("--resume-archive", type=Path, help="publish a previously built and verified archive")
    args = parser.parse_args()

    if not PACKAGE_JSON.exists():
        raise SystemExit(f"package.json not found: {PACKAGE_JSON}")
    if not UPDATE_CONFIG.exists():
        raise SystemExit(f"update_config.json not found: {UPDATE_CONFIG}")

    pkg = read_json(PACKAGE_JSON)
    current_version = str(pkg.get("version", "1.0.0"))

    version = args.version
    if not version:
        version = current_version if args.resume_archive else input(f"Input new version (current: {current_version}): ")
    version = version.strip()
    if not version:
        raise SystemExit("Version is required.")

    if Path(version).name != version or version in (".", ".."):
        raise SystemExit("Invalid version.")
    release_notes = (args.release_notes or input("Input release notes (optional): ")).strip() or f"Updated to version {version}: fixes and improvements."

    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    zip_name = f"shangpin-cloud-assets-{version}.zip"
    zip_path = RELEASES_DIR / zip_name
    if args.resume_archive:
        pending = args.resume_archive.resolve(strict=True)
        if pending.parent != RELEASES_DIR.resolve() or (pending.suffix != ".part" and pending != zip_path):
            raise SystemExit("Select a .part file in releases or the completed ZIP for this version.")
        with zipfile.ZipFile(pending) as archive:
            packaged = json.loads(archive.read(f"{APP_DIR.name}/package.json"))
            if packaged.get("name") != pkg["name"] or packaged.get("version") != version:
                raise SystemExit("Package identity or version does not match.")
            bad_file = archive.testzip()
            if bad_file:
                raise SystemExit(f"ZIP verification failed for {bad_file}")
        if pending != zip_path:
            install_archive(pending, zip_path)
    else:
        build_archive(pkg, version, zip_path)

    cfg = read_json(UPDATE_CONFIG)
    cfg.update(version=version, fileName=zip_name, releaseNotes=release_notes)
    write_json(UPDATE_CONFIG, cfg)
    print(f"Publish complete. Version: {version}\nPackage: {zip_path}")
    client_config = PROJECT_ROOT / "server_config.json"
    try:
        lan_base_url = read_json(client_config).get("lanBaseUrl")
        if lan_base_url:
            print(f"LAN download URL: {lan_base_url.rstrip('/')}/releases/{zip_name}")
    except (OSError, ValueError):
        pass
    public_base_url = str(cfg.get("publicBaseUrl", "")).rstrip("/")
    if public_base_url:
        print(f"External download URL: {public_base_url}/releases/{zip_name}")


def build_archive(pkg: dict, version: str, zip_path: Path) -> None:
    # electron-builder is configured to keep the native modules used by the host Node runtime.
    probe = ["node", "-e", "new(require('better-sqlite3'))(':memory:').close()"]
    if subprocess.run(probe, cwd=PROJECT_ROOT, capture_output=True).returncode:
        run([get_npm_cmd(), "rebuild", "better-sqlite3"])
        run(probe)

    pkg["version"] = version
    write_json(PACKAGE_JSON, pkg)

    print("Running electron build...")
    run([get_npm_cmd(), "run", "electron:build"])

    app_dir = normalize_app_dir()
    copy_backend_runtime(app_dir)

    print(f"Compressing app dir to: {zip_path}")
    zip_dir(app_dir, zip_path, APP_DIR.name if app_dir == APP_DIR_FALLBACK else None)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Publish cancelled.")
