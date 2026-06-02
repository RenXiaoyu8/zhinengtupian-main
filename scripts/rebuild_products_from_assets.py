from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ASSETS_ROOT_DEFAULT = Path("D:/") / "".join(
    chr(c) for c in [0x5C1A, 0x54C1, 0x6613, 0x7AD9, 0x56FE, 0x7247]
)
APP_DATA_FOLDER = "".join(chr(c) for c in [0x7A0B, 0x5E8F, 0x56FE, 0x7247, 0x52FF, 0x52A8])
DEFAULT_PRODUCT_ROOTS = ["产品图片", "视频", "检测报告"]
PRIMARY_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
SECONDARY_IMAGE_EXTS = {".ai", ".pdf", ".psd", ".tif", ".tiff", ".svg"}
SKIP_PRODUCT_DIR_KEYWORDS = ["品牌文件"]


@dataclass
class ProductCandidate:
    brand_name: str
    product_name: str
    product_dir: Path
    image_path: str
    file_paths: list[str]


def forward_slash(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def load_product_roots(app_data_dir: Path) -> list[str]:
    product_folders = app_data_dir / "product_folders.json"
    if not product_folders.exists():
        return DEFAULT_PRODUCT_ROOTS

    try:
        data = json.loads(product_folders.read_text(encoding="utf-8-sig"))
        roots: list[str] = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    name = str(item.get("name", "")).strip()
                    if name:
                        roots.append(name)
        return roots or DEFAULT_PRODUCT_ROOTS
    except Exception:
        return DEFAULT_PRODUCT_ROOTS


def list_dirs(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted([p for p in path.iterdir() if p.is_dir()], key=lambda p: p.name.lower())


def iter_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted([p for p in path.rglob("*") if p.is_file()], key=lambda p: p.as_posix().lower())


def choose_image(product_dir: Path, assets_root: Path) -> str:
    preferred_dirs = [
        product_dir / "产品图片" / "主图",
        product_dir / "产品图片" / "原图",
        product_dir / "产品图片" / "详情页",
        product_dir / "产品图片",
        product_dir,
    ]

    all_files: list[Path] = []
    for preferred in preferred_dirs:
        files = iter_files(preferred)
        if not files:
            continue
        all_files.extend(files)

        for ext_group in (PRIMARY_IMAGE_EXTS, SECONDARY_IMAGE_EXTS):
            for file_path in files:
                if file_path.suffix.lower() in ext_group:
                    return forward_slash(file_path, assets_root)

    if all_files:
        return forward_slash(all_files[0], assets_root)
    return ""


def detect_products(assets_root: Path, app_data_dir: Path) -> list[ProductCandidate]:
    product_roots = load_product_roots(app_data_dir)
    candidates: list[ProductCandidate] = []

    for brand_dir in list_dirs(assets_root):
        if brand_dir.name == app_data_dir.name:
            continue

        for product_dir in list_dirs(brand_dir):
            if any(keyword in product_dir.name for keyword in SKIP_PRODUCT_DIR_KEYWORDS):
                continue

            has_template_root = any((product_dir / root_name).exists() for root_name in product_roots)
            if not has_template_root:
                continue

            file_paths = [forward_slash(p, assets_root) for p in iter_files(product_dir)]
            if not file_paths:
                continue

            candidates.append(
                ProductCandidate(
                    brand_name=brand_dir.name,
                    product_name=product_dir.name,
                    product_dir=product_dir,
                    image_path=choose_image(product_dir, assets_root),
                    file_paths=file_paths,
                )
            )

    return sorted(candidates, key=lambda c: (c.brand_name.lower(), c.product_name.lower()))


def sku_prefix_for_brand(brand_name: str) -> str:
    letters = "".join(ch for ch in brand_name.upper() if ("A" <= ch <= "Z") or ch.isdigit())
    if letters:
        return letters[:6]
    return "P"


def existing_product_map(conn: sqlite3.Connection) -> dict[tuple[str, str], dict]:
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT p.sku, p.official_name, p.names, p.image_path, b.name AS brand_name
        FROM products p
        LEFT JOIN brands b ON p.brand_id = b.id
        """
    ).fetchall()
    result: dict[tuple[str, str], dict] = {}
    for sku, official_name, names, image_path, brand_name in rows:
        key = (str(brand_name or "").strip(), str(official_name or "").strip())
        result[key] = {
            "sku": str(sku or "").strip(),
            "names": str(names or "").strip(),
            "image_path": str(image_path or "").strip(),
        }
    return result


def make_unique_sku(existing_skus: set[str], brand_name: str, product_name: str, index: int) -> str:
    prefix = sku_prefix_for_brand(brand_name)
    base = f"{prefix}-REC-{index:03d}"
    candidate = base
    suffix = 1
    while candidate in existing_skus:
        suffix += 1
        candidate = f"{base}-{suffix}"
    existing_skus.add(candidate)
    return candidate


def preview(candidates: list[ProductCandidate], conn: sqlite3.Connection) -> dict:
    existing = existing_product_map(conn)
    existing_skus = {
        row[0]
        for row in conn.execute("SELECT sku FROM products").fetchall()
        if isinstance(row[0], str) and row[0].strip()
    }

    brands = sorted({c.brand_name for c in candidates})
    preview_rows = []
    for index, candidate in enumerate(candidates, start=1):
        key = (candidate.brand_name, candidate.product_name)
        old = existing.get(key)
        sku = old["sku"] if old and old["sku"] else make_unique_sku(existing_skus, candidate.brand_name, candidate.product_name, index)
        names = old["names"] if old else ""
        old_image_path = old["image_path"] if old else ""
        old_image_exists = bool(old_image_path) and (ASSETS_ROOT_DEFAULT / Path(old_image_path.replace("/", os.sep))).exists()
        image_path = old_image_path if old_image_exists else candidate.image_path
        preview_rows.append(
            {
                "brand_name": candidate.brand_name,
                "official_name": candidate.product_name,
                "sku": sku,
                "names": names,
                "image_path": image_path,
                "file_count": len(candidate.file_paths),
            }
        )

    return {
        "brand_count": len(brands),
        "product_count": len(preview_rows),
        "sample": preview_rows[:30],
    }


def backup_db(db_path: Path) -> Path:
    backup_path = db_path.with_name(f"{db_path.stem}.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def apply_rebuild(candidates: list[ProductCandidate], conn: sqlite3.Connection) -> dict:
    existing = existing_product_map(conn)
    existing_skus = {
        row[0]
        for row in conn.execute("SELECT sku FROM products").fetchall()
        if isinstance(row[0], str) and row[0].strip()
    }

    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        cur.execute("DELETE FROM file_tags")
        cur.execute("DELETE FROM product_variants")
        cur.execute("DELETE FROM products")
        cur.execute("DELETE FROM brands")
        cur.execute("DELETE FROM sqlite_sequence WHERE name IN ('file_tags','product_variants','products','brands')")

        brand_id_map: dict[str, int] = {}
        for brand_name in sorted({c.brand_name for c in candidates}):
            cur.execute("INSERT INTO brands (name) VALUES (?)", (brand_name,))
            brand_id_map[brand_name] = int(cur.lastrowid)

        inserted_products = 0
        inserted_tags = 0
        for index, candidate in enumerate(candidates, start=1):
            key = (candidate.brand_name, candidate.product_name)
            old = existing.get(key)
            sku = old["sku"] if old and old["sku"] else make_unique_sku(existing_skus, candidate.brand_name, candidate.product_name, index)
            names = old["names"] if old else ""
            old_image_path = old["image_path"] if old else ""
            old_image_exists = bool(old_image_path) and (ASSETS_ROOT_DEFAULT / Path(old_image_path.replace("/", os.sep))).exists()
            image_path = old_image_path if old_image_exists else candidate.image_path

            cur.execute(
                "INSERT INTO products (sku, official_name, names, brand_id, image_path) VALUES (?, ?, ?, ?, ?)",
                (sku, candidate.product_name, names, brand_id_map[candidate.brand_name], image_path),
            )
            product_id = int(cur.lastrowid)
            inserted_products += 1

            for file_path in candidate.file_paths:
                cur.execute(
                    "INSERT INTO file_tags (file_path, product_id, variant_id) VALUES (?, ?, NULL)",
                    (file_path, product_id),
                )
                inserted_tags += 1

        conn.commit()
        return {
            "brands": len(brand_id_map),
            "products": inserted_products,
            "file_tags": inserted_tags,
        }
    except Exception:
        conn.rollback()
        raise


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Rebuild products table from asset folders.")
    parser.add_argument("--apply", action="store_true", help="Write changes to the database.")
    args = parser.parse_args()

    assets_root = ASSETS_ROOT_DEFAULT
    app_data_dir = assets_root / APP_DATA_FOLDER
    db_path = app_data_dir / "visualflow.db"

    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    candidates = detect_products(assets_root, app_data_dir)
    if not candidates:
        raise SystemExit("No product folders detected from assets.")

    conn = sqlite3.connect(db_path)
    try:
        preview_result = preview(candidates, conn)
        print(json.dumps({"mode": "preview", **preview_result}, ensure_ascii=False, indent=2))

        if not args.apply:
            return

        backup_path = backup_db(db_path)
        print(json.dumps({"backup": str(backup_path)}, ensure_ascii=False, indent=2))

        result = apply_rebuild(candidates, conn)
        print(json.dumps({"mode": "applied", **result}, ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
