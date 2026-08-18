#!/usr/bin/env python3
"""每日增量抓取：默认拉取「北京时间昨天」qType=0/1/2 的研报，裁剪 15 字段，
按 publishDate 月份合并进 site/data/reports-YYYY-MM.json
（infoCode 去重、publishDate 排序、每条一行；新记录覆盖同 infoCode 旧记录）。

健康检查（CI 据此跳过部署）：
- 任一请求重试后仍失败 → exit 1
- 三类合计为 0 且目标日为工作日（周一~周五）→ exit 1（疑似上游异常）
- 周末/节假日为 0 → 正常退出（无变更，change-only 自然跳过部署）

CLI：fetch_reports.py --repo-root . [--date YYYY-MM-DD]
"""

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD，默认北京时间昨天")
    args = ap.parse_args()

    if args.date:
        day = args.date
    else:
        beijing_now = datetime.now(timezone.utc) + timedelta(hours=8)
        day = (beijing_now.date() - timedelta(days=1)).isoformat()

    root = Path(args.repo_root)
    per_q = {}
    total = 0
    for q in (0, 1, 2):
        try:
            recs = common.fetch_range(day, day, q)
        except Exception as e:
            print(f"ERROR: fetch qType={q} for {day} failed: {e}", file=sys.stderr)
            return 1
        per_q[q] = recs
        total += len(recs)
        print(f"qType={q}: {len(recs)} records")

    if total == 0:
        if datetime.strptime(day, "%Y-%m-%d").weekday() < 5:
            print(f"ERROR: all qTypes returned 0 on weekday {day}, suspected upstream issue",
                  file=sys.stderr)
            return 1
        print(f"WARN: 0 records on {day} (weekend), nothing to merge")
        return 0

    by_month = {}
    for q in (0, 1, 2):
        for r in per_q[q]:
            ym = r["publishDate"][:7] or day[:7]
            by_month.setdefault(ym, []).append(r)

    for ym, recs in sorted(by_month.items()):
        path = common.shard_path(root, ym)
        existing = common.read_shard(path)
        merged = common.merge_records(existing, recs)
        common.write_shard(path, merged)
        print(f"shard {path.name}: +{len(merged) - len(existing)} (total {len(merged)})")

    print(f"OK: {day} fetched {total} records into {len(by_month)} shard(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
