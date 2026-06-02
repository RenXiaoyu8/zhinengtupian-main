"""列出：数据库里有、但磁盘上无同名产品文件夹（与 match_products_to_folders 规则一致）的产品。"""
from __future__ import annotations

import sqlite3
import sys

import match_products_to_folders as m


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    db = m.ASSETS_ROOT / m.APP_DATA_FOLDER / "visualflow.db"
    conn = sqlite3.connect(db)
    prods = m.load_products(conn)
    folders = m.collect_folder_candidates(m.ASSETS_ROOT, m.ASSETS_ROOT / m.APP_DATA_FOLDER)
    mapped, _ = m.build_mapping(prods, folders)
    conn.close()
    miss = [p for p in prods if p.id not in mapped]
    print(f"共 {len(miss)} 个产品未匹配到文件夹（品牌+文件夹名=正式名/别名/货号，规范化后完全相同）：\n")
    for p in sorted(miss, key=lambda x: (x.sku or "")):
        alias = p.names.strip() if p.names else "(无)"
        print(f"  货号: {p.sku}")
        print(f"  正式名: {p.official_name}")
        print(f"  别名: {alias}")
        print(f"  品牌: {p.brand_name}")
        print()


if __name__ == "__main__":
    main()
