#!/usr/bin/env python3
"""东财研报列表抓取与月分片读写的公共模块。

上游契约（详见内部 EASTMONEY_API.md）：
- 请求必须携带 User-Agent 与 Referer: https://data.eastmoney.com/
- 响应可能为 JSONP（datatable(...)），需正则提取括号内 JSON
- publishDate 形如 "YYYY-MM-DD HH:MM:SS.mmm"，入库截取前 10 位
- PDF 直链：https://pdf.dfcfw.com/pdf/H3_{infoCode}_1.pdf
"""

import calendar
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

API_URL = "https://reportapi.eastmoney.com/report/list"
REFERER = "https://data.eastmoney.com/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Referer": REFERER,
}

TRIM_FIELDS = [
    "title", "orgName", "orgSName", "infoCode", "publishDate", "industryName",
    "emRatingName", "sRatingName", "researcher", "stockName", "stockCode",
    "attachPages", "encodeUrl", "attachSize",
]


def data_dir(repo_root):
    return Path(repo_root) / "site" / "data"


def shard_path(repo_root, ym):
    return data_dir(repo_root) / f"reports-{ym}.json"


def trim_record(raw, qtype):
    rec = {k: raw.get(k, "") for k in TRIM_FIELDS}
    rec["publishDate"] = (rec["publishDate"] or "")[:10]
    rec["qType"] = qtype
    return rec


def parse_payload(text):
    t = text.strip()
    if t.startswith("datatable"):
        m = re.search(r"\((.*)\)", t, re.S)
        if not m:
            raise ValueError("JSONP payload without JSON body")
        t = m.group(1)
    return json.loads(t)


def fetch_page(begin_time, end_time, qtype, page_no, page_size=100, retries=3, timeout=30):
    params = {
        "beginTime": begin_time, "endTime": end_time,
        "pageNo": page_no, "pageSize": page_size, "qType": qtype,
        "industryCode": "*", "industry": "*", "rating": "*", "ratingChange": "*",
        "orgCode": "", "rcode": "", "fields": "", "_": int(time.time() * 1000),
    }
    url = API_URL + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            return parse_payload(text)
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"fetch failed after {retries} attempts: {url}: {last_err}")


def fetch_range(begin_time, end_time, qtype, interval=1.0):
    first = fetch_page(begin_time, end_time, qtype, 1)
    pages = max(1, int(first.get("TotalPage") or 0))
    data = list(first.get("data") or [])
    for page in range(2, pages + 1):
        if interval > 0:
            time.sleep(interval)
        payload = fetch_page(begin_time, end_time, qtype, page)
        data.extend(payload.get("data") or [])
    by_id = {}
    for raw in data:
        rec = trim_record(raw, qtype)
        by_id[rec["infoCode"]] = rec
    return list(by_id.values())


def read_shard(path):
    if not Path(path).exists():
        return []
    return json.loads(Path(path).read_text(encoding="utf-8"))


def merge_records(existing, incoming):
    by_id = {r["infoCode"]: r for r in existing}
    for r in incoming:
        by_id[r["infoCode"]] = r
    return sorted(by_id.values(), key=lambda r: (r.get("publishDate", ""), r.get("infoCode", "")))


def write_shard(path, records):
    path = Path(path)
    if not records:
        if path.exists():
            path.unlink()
        return
    lines = ["["]
    for i, rec in enumerate(records):
        sep = "," if i < len(records) - 1 else ""
        lines.append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + sep)
    lines.append("]")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def month_bounds(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{ym}-01", f"{ym}-{calendar.monthrange(y, m)[1]:02d}"
