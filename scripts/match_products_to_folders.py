from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ASSETS_ROOT = Path("D:/") / "".join(chr(c) for c in [0x5C1A, 0x54C1, 0x6613, 0x7AD9, 0x56FE, 0x7247])
APP_DATA_FOLDER = "".join(chr(c) for c in [0x7A0B, 0x5E8F, 0x56FE, 0x7247, 0x52FF, 0x52A8])
DEFAULT_PRODUCT_ROOTS = ["产品图片", "视频", "检测报告"]
PRIMARY_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
SECONDARY_IMAGE_EXTS = {".ai", ".pdf", ".psd", ".tif", ".tiff", ".svg"}

# 匹配优先级：数字越小越优先（用于同一文件夹命中多条产品信息时）
PRI_OFFICIAL = 1
PRI_ALIAS = 2
PRI_SKU = 3


@dataclass
class Product:
    id: int
    sku: str
    official_name: str
    names: str
    brand_id: int | None
    brand_name: str


@dataclass
class FolderCandidate:
    brand_name: str
    product_name: str
    folder_path: Path
    rel_files: list[str]
    image_path: str


def normalize_text(v: str) -> str:
    """用于比较「是否同一名称」：去空白、统一大小写、去掉常见标点。"""
    s = (v or "").strip().lower()
    s = re.sub(r"[\s\-_/\\|,，、.·()（）\[\]【】]+", "", s)
    return s


def split_aliases(names: str) -> list[str]:
    raw = (names or "").strip()
    if not raw:
        return []
    parts = re.split(r"[,\n\r\t，、;；]+", raw)
    return [p.strip() for p in parts if p.strip()]


def load_product_roots(app_data_dir: Path) -> list[str]:
    f = app_data_dir / "product_folders.json"
    if not f.exists():
        return DEFAULT_PRODUCT_ROOTS
    try:
        data = json.loads(f.read_text(encoding="utf-8-sig"))
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


def iter_dirs(p: Path) -> list[Path]:
    if not p.exists():
        return []
    return sorted([x for x in p.iterdir() if x.is_dir()], key=lambda x: x.name.lower())


def iter_files(p: Path) -> list[Path]:
    if not p.exists():
        return []
    return sorted([x for x in p.rglob("*") if x.is_file()], key=lambda x: x.as_posix().lower())


def choose_image(product_dir: Path, assets_root: Path) -> str:
    preferred_dirs = [
        product_dir / "产品图片" / "主图",
        product_dir / "产品图片" / "原图",
        product_dir / "产品图片" / "详情页",
        product_dir / "产品图片",
        product_dir,
    ]
    all_files: list[Path] = []
    for d in preferred_dirs:
        files = iter_files(d)
        if not files:
            continue
        all_files.extend(files)
        for ext_group in (PRIMARY_IMAGE_EXTS, SECONDARY_IMAGE_EXTS):
            for f in files:
                if f.suffix.lower() in ext_group:
                    return f.relative_to(assets_root).as_posix()
    if all_files:
        return all_files[0].relative_to(assets_root).as_posix()
    return ""


def collect_folder_candidates(assets_root: Path, app_data_dir: Path) -> list[FolderCandidate]:
    roots = load_product_roots(app_data_dir)
    result: list[FolderCandidate] = []
    for brand_dir in iter_dirs(assets_root):
        if brand_dir.name == app_data_dir.name:
            continue
        for product_dir in iter_dirs(brand_dir):
            if not any((product_dir / r).exists() for r in roots):
                continue
            # 空目录也要参与匹配：用户可能刚自动建好文件夹尚未上传文件，否则会被误判为「无文件夹」
            files = iter_files(product_dir)
            rel_files = [f.relative_to(assets_root).as_posix() for f in files]
            result.append(
                FolderCandidate(
                    brand_name=brand_dir.name.strip(),
                    product_name=product_dir.name.strip(),
                    folder_path=product_dir,
                    rel_files=rel_files,
                    image_path=choose_image(product_dir, assets_root),
                )
            )
    return result


def load_products(conn: sqlite3.Connection) -> list[Product]:
    rows = conn.execute(
        """
        SELECT p.id, p.sku, p.official_name, p.names, p.brand_id, COALESCE(b.name, '')
        FROM products p
        LEFT JOIN brands b ON b.id = p.brand_id
        ORDER BY p.id
        """
    ).fetchall()
    return [
        Product(
            id=int(r[0]),
            sku=str(r[1] or "").strip(),
            official_name=str(r[2] or "").strip(),
            names=str(r[3] or "").strip(),
            brand_id=(int(r[4]) if r[4] is not None else None),
            brand_name=str(r[5] or "").strip(),
        )
        for r in rows
    ]


def brands_match(p: Product, c: FolderCandidate) -> bool:
    """产品品牌与磁盘品牌文件夹名需一致（规范化后）。"""
    pb = normalize_text(p.brand_name)
    cb = normalize_text(c.brand_name)
    if not pb or not cb:
        return False
    return pb == cb


def folder_match_priority(p: Product, c: FolderCandidate) -> int | None:
    """
    仅「完全相同」规则（规范化后）：
    - 文件夹名 == 产品正式名
    - 或 文件夹名 == 某一别名
    - 或 文件夹名 == 货号 SKU
    返回优先级；不匹配返回 None。
    """
    if not brands_match(p, c):
        return None
    fn = normalize_text(c.product_name)
    if not fn:
        return None

    if fn == normalize_text(p.official_name):
        return PRI_OFFICIAL
    for a in split_aliases(p.names):
        if fn == normalize_text(a):
            return PRI_ALIAS
    if p.sku and fn == normalize_text(p.sku):
        return PRI_SKU
    return None


def build_mapping(products: list[Product], folders: list[FolderCandidate]) -> tuple[dict[int, FolderCandidate], list[FolderCandidate]]:
    """
    每个产品目录最多对应一个产品行；每个产品行最多对应一个目录。
    同一目录若多条产品命中，取优先级最高（正式名 > 别名 > 货号），再取 id 最小。
    """
    mapped: dict[int, FolderCandidate] = {}
    used_product_ids: set[int] = set()
    used_folder_idx: set[int] = set()

    for i, c in enumerate(folders):
        if i in used_folder_idx:
            continue
        best: tuple[int, int, int] | None = None  # (priority, product_id, folder_idx)
        for p in products:
            if p.id in used_product_ids:
                continue
            pr = folder_match_priority(p, c)
            if pr is None:
                continue
            cand = (pr, p.id, i)
            if best is None:
                best = cand
            else:
                if pr < best[0] or (pr == best[0] and p.id < best[1]):
                    best = (pr, p.id, i)
        if best is None:
            continue
        _, pid, fi = best
        mapped[pid] = folders[fi]
        used_product_ids.add(pid)
        used_folder_idx.add(fi)

    unmatched = [c for i, c in enumerate(folders) if i not in used_folder_idx]
    return mapped, unmatched


def match_reason(p: Product, c: FolderCandidate) -> str:
    pr = folder_match_priority(p, c)
    if pr == PRI_OFFICIAL:
        return "official_name"
    if pr == PRI_ALIAS:
        return "alias"
    if pr == PRI_SKU:
        return "sku"
    return "unknown"


def preview(mapped: dict[int, FolderCandidate], products: list[Product], unmatched: list[FolderCandidate]) -> dict:
    pmap = {p.id: p for p in products}
    rows = []
    file_count = 0
    for pid, c in sorted(mapped.items(), key=lambda x: x[0]):
        p = pmap[pid]
        file_count += len(c.rel_files)
        rows.append(
            {
                "product_id": pid,
                "sku": p.sku,
                "official_name": p.official_name,
                "alias": p.names,
                "match_by": match_reason(p, c),
                "brand_from_product": p.brand_name,
                "brand_from_folder": c.brand_name,
                "folder": c.folder_path.as_posix(),
                "file_count": len(c.rel_files),
            }
        )
    return {
        "products_total": len(products),
        "products_matched": len(mapped),
        "products_unmatched": len(products) - len(mapped),
        "folders_unmatched": len(unmatched),
        "file_tags_to_write": file_count,
        "sample": rows[:40],
    }


def backup_db(db_path: Path) -> Path:
    backup_path = db_path.with_name(f"{db_path.stem}.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def _delete_tags_for_paths(cur: sqlite3.Cursor, paths: list[str]) -> None:
    if not paths:
        return
    chunk = 400
    for i in range(0, len(paths), chunk):
        batch = paths[i : i + chunk]
        placeholders = ",".join("?" * len(batch))
        cur.execute(f"DELETE FROM file_tags WHERE file_path IN ({placeholders})", batch)


def apply(conn: sqlite3.Connection, mapped: dict[int, FolderCandidate]) -> dict:
    """
    只写 file_tags：把文件关联到已有 product_id（产品里的货号、别名等仍在 products 表，不改）。
    不修改 products / brands，不碰磁盘文件夹。
    """
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        all_paths: list[str] = []
        for cand in mapped.values():
            all_paths.extend(cand.rel_files)
        _delete_tags_for_paths(cur, all_paths)

        tags = 0
        for pid, cand in mapped.items():
            for fp in cand.rel_files:
                cur.execute(
                    "INSERT INTO file_tags (file_path, product_id, variant_id) VALUES (?, ?, NULL)",
                    (fp, pid),
                )
                tags += 1
        conn.commit()
        return {
            "matched_products": len(mapped),
            "file_tags_written": tags,
            "note": "仅更新 file_tags；未修改 products 与磁盘目录。标签指向的产品行含你填写的货号/别名等。",
        }
    except Exception:
        conn.rollback()
        raise


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="按「产品正式名/别名/货号」与文件夹名完全相同（规范化后）做匹配，只写 file_tags；不改产品与文件夹。"
    )
    parser.add_argument("--apply", action="store_true", help="写入数据库（会先自动备份 visualflow.db）。")
    args = parser.parse_args()

    db_path = ASSETS_ROOT / APP_DATA_FOLDER / "visualflow.db"
    if not db_path.exists():
        raise SystemExit(f"数据库不存在: {db_path}")

    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(db_path)
        products = load_products(conn)
        folders = collect_folder_candidates(ASSETS_ROOT, ASSETS_ROOT / APP_DATA_FOLDER)
        mapped, unmatched = build_mapping(products, folders)
        print(json.dumps({"mode": "preview", **preview(mapped, products, unmatched)}, ensure_ascii=False, indent=2))
        if not args.apply:
            return

        conn.close()
        conn = None

        backup_path = backup_db(db_path)
        print(json.dumps({"backup": str(backup_path)}, ensure_ascii=False, indent=2))

        conn = sqlite3.connect(db_path)
        result = apply(conn, mapped)
        print(json.dumps({"mode": "applied", **result}, ensure_ascii=False, indent=2))
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()
