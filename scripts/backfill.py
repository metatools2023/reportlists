#!/usr/bin/env python3
"""历史回填：遍历 月份×qType（默认 2017-01 → 当前月 × qType 0/1/2），
pageSize=100 循环至 TotalPage，请求间隔 1s，断点续跑（site/data/state.json），
每 ~10 单元 commit+push 一次，失败单元记清单不阻塞，批末构建索引并收尾 commit。

顺序分批（--max-units N，默认 35，345 单元 ÷ 10 批 ≈ 13 分钟/批）：
- 每次运行最多处理 N 个未完成单元后干净退出（exit 0），全量约 10 批
- 重跑自动从未完成处继续，无需记批次号；重跑优先补失败单元
- 批末若存在本次新失败单元则 exit 非零提醒
- 首个全新单元即失败 → 判定上游不可用，整批中止（不烧批次不污染状态）

CLI：backfill.py --repo-root . --interval 1 --max-units 35 [--from YYYY-MM]

契约：
- 保留 15 字段（14 个 API 字段 + qType），单请求 3 次指数退避重试
- 月内按 infoCode 去重，每条记录独立一行存储
- state.json：{done: {key: {count, at}}, failed: [...], stats: {completed, remaining, failed, last_run}}
- CI 环境通过 GITHUB_OUTPUT 输出 changed=true/false 供部署条件判断
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

START_DEFAULT = "2017-01"
COMMIT_EVERY = 10
BOT_IDENT = ("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com")
LOCAL_IDENT = ("metatools2023", "metatools2023@users.noreply.github.com")


def month_list(start_ym, end_ym):
    y, m = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def unit_key(ym, q):
    return f"{ym}:q{q}"


def state_path(root):
    return common.data_dir(root) / "state.json"


def load_state(root):
    p = state_path(root)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"done": {}, "failed": []}


def save_state(root, state):
    common.data_dir(root).mkdir(parents=True, exist_ok=True)
    state_path(root).write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n",
                                encoding="utf-8")


def git(root, *args, check=True):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                          text=True, check=check)


def has_origin(root):
    return git(root, "remote", "get-url", "origin", check=False).returncode == 0


def commit_data(root, msg):
    git(root, "add", "site/data")
    if git(root, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    name, email = BOT_IDENT if os.environ.get("CI") else LOCAL_IDENT
    git(root, "-c", f"user.name={name}", "-c", f"user.email={email}",
        "commit", "-m", msg)
    if has_origin(root):
        pull = git(root, "-c", "rebase.autoStash=true", "pull", "--rebase", check=False)
        if pull.returncode != 0:
            print(f"WARN: git pull --rebase failed, push skipped:\n{pull.stderr}", file=sys.stderr)
            return True
        push = git(root, "push", check=False)
        if push.returncode != 0:
            print(f"WARN: git push failed:\n{push.stderr}", file=sys.stderr)
    return True


def emit_changed(changed):
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


def summarize(state, total_units):
    done = len(state.get("done", {}))
    failed = len(state.get("failed", []))
    print(f"progress: {done}/{total_units} units done, "
          f"{max(0, total_units - done - failed)} pending, {failed} failed")
    if failed:
        preview = ", ".join(state["failed"][:20])
        print(f"failed units (first 20): {preview}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--max-units", type=int, default=35, help="0 = 不限")
    ap.add_argument("--from", dest="from_month", default=START_DEFAULT)
    args = ap.parse_args()

    root = Path(args.repo_root)
    months = month_list(args.from_month, datetime.now(timezone.utc).strftime("%Y-%m"))
    all_units = [(ym, q) for ym in months for q in (0, 1, 2)]
    state = load_state(root)
    done = state.setdefault("done", {})
    failed_set = set(state.setdefault("failed", []))

    pending = [u for u in all_units if unit_key(*u) not in done]
    batch = ([u for u in pending if unit_key(*u) in failed_set]
             + [u for u in pending if unit_key(*u) not in failed_set])
    if args.max_units > 0:
        batch = batch[:args.max_units]

    if not batch:
        print(f"nothing to do: {len(done)} units done, {len(failed_set)} failed")
        emit_changed(False)
        summarize(state, len(all_units))
        return 1 if failed_set else 0

    print(f"batch: {len(batch)} units (done={len(done)}, failed_backlog="
          f"{sum(1 for u in batch if unit_key(*u) in failed_set)}, interval={args.interval}s)")

    ok_count = 0
    new_failures = []
    any_changed = False
    since_commit = 0
    for i, (ym, q) in enumerate(batch):
        key = unit_key(ym, q)
        begin, end = common.month_bounds(ym)
        try:
            recs = common.fetch_range(begin, end, q, interval=args.interval)
        except Exception as e:
            if i == 0 and key not in failed_set:
                print(f"ABORT: first fresh unit {key} failed, upstream likely unavailable: {e}",
                      file=sys.stderr)
                return 1
            print(f"FAIL {key}: {e}", file=sys.stderr)
            new_failures.append(key)
            failed_set.add(key)
            continue

        failed_set.discard(key)
        done[key] = {"count": len(recs), "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if recs:
            path = common.shard_path(root, ym)
            common.write_shard(path, common.merge_records(common.read_shard(path), recs))
        ok_count += 1
        since_commit += 1
        print(f"done {key}: {len(recs)} records")
        if since_commit >= COMMIT_EVERY:
            any_changed |= commit_data(
                root, f"data: backfill progress ({len(done)}/{len(all_units)} units)")
            state["failed"] = sorted(failed_set)
            save_state(root, state)
            since_commit = 0
        if i < len(batch) - 1 and args.interval > 0:
            time.sleep(args.interval)

    try:
        import build_index
        build_index.build(root)
    except Exception as e:
        print(f"WARN: build_index failed: {e}", file=sys.stderr)

    state["failed"] = sorted(failed_set)
    state["stats"] = {
        "completed": len(done), "remaining": len(all_units) - len(done),
        "failed": len(failed_set),
        "last_run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    save_state(root, state)
    any_changed |= commit_data(
        root, f"data: backfill batch (+{ok_count} units, {len(done)}/{len(all_units)})")
    emit_changed(any_changed)
    summarize(state, len(all_units))
    return 1 if new_failures else 0


if __name__ == "__main__":
    sys.exit(main())
