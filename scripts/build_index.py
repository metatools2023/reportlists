#!/usr/bin/env python3
"""构建索引：由 site/data/reports-YYYY-MM.json 分片生成
- site/data/tags.json       标签聚合（industry/org/rating/researcher/stock；
                             researcher/stock 仅保留 top 1000，其余维度全量）
                             含 years 元数据（年份列表+计数，倒序，供前端全库搜索）
- site/data/index-YYYY.json 按年搜索索引（精简字段 i/d/t/o/n/r/q/s/a，每条一行）

字段映射：i=infoCode d=publishDate t=title o=orgSName n=industryName
          r=评级(emRatingName 回退 sRatingName) q=qType s=stockName a=researcher

CLI：build_index.py --repo-root .
可被 backfill.py 直接调用：build_index.build(repo_root)
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

TOP_LIMITS = {"researcher": 1000, "stock": 1000}


def rating_of(rec):
    return (rec.get("emRatingName") or rec.get("sRatingName") or "").strip()


def dim_values(rec):
    return {
        "industry": (rec.get("industryName") or "").strip(),
        "org": (rec.get("orgSName") or "").strip(),
        "rating": rating_of(rec),
        "researcher": (rec.get("researcher") or "").strip(),
        "stock": (rec.get("stockName") or "").strip(),
    }


def compact(rec):
    return {
        "i": rec.get("infoCode", ""), "d": rec.get("publishDate", ""),
        "t": rec.get("title", ""), "o": rec.get("orgSName", ""),
        "n": rec.get("industryName", ""), "r": rating_of(rec),
        "q": rec.get("qType"), "s": rec.get("stockName", ""),
        "a": rec.get("researcher", ""),
    }


def write_index(path, year, rows):
    lines = ["{", f'"year": "{year}", "count": {len(rows)}, "reports": [']
    for i, r in enumerate(rows):
        sep = "," if i < len(rows) - 1 else ""
        lines.append(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + sep)
    lines.append("]}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(repo_root):
    root = Path(repo_root)
    out_dir = common.data_dir(root)
    counts = {d: Counter() for d in ("industry", "org", "rating", "researcher", "stock")}
    years = {}
    total = 0
    for p in sorted(out_dir.glob("reports-*.json")):
        for rec in common.read_shard(p):
            total += 1
            for dim, val in dim_values(rec).items():
                if val:
                    counts[dim][val] += 1
            yr = (rec.get("publishDate") or "")[:4]
            if yr:
                years.setdefault(yr, []).append(compact(rec))

    tags = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": total,
        "years": [{"year": yr, "count": len(rows)}
                  for yr, rows in sorted(years.items(), key=lambda kv: kv[0], reverse=True)],
        "tags": {
            dim: [{"name": n, "count": c} for n, c in sorted(
                cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_LIMITS.get(dim)]]
            for dim, cnt in counts.items()
        },
    }
    (out_dir / "tags.json").write_text(
        json.dumps(tags, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    for stale in out_dir.glob("index-*.json"):
        if stale.name[6:10] not in years:
            stale.unlink()
    for yr in sorted(years):
        write_index(out_dir / f"index-{yr}.json", yr, years[yr])

    print(f"index: {total} reports, {len(years)} year index(es), "
          f"tags: " + ", ".join(f"{d}={len(tags['tags'][d])}" for d in tags["tags"]))
    return tags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".")
    args = ap.parse_args()
    build(args.repo_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
