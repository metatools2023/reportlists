#!/usr/bin/env python3
"""构建统计分片：由 site/data/reports-YYYY-MM.json 生成 site/data/stats/*.json（供 stats.html 使用）。

输出（口径详见本地 analysis/findings.md）：
- overview.json      总量/日期区间/各维度基数
- monthly.json       月度总量/qType 三分/评级结构/情绪指数(sentiment/buy_pct)
- heatmap.json       Top30 行业 × 月度发布量矩阵
- timepatterns.json  星期/月份/月内(按历法天数归一)分布
- orgs.json          Top50 机构画像
- researchers.json   Top50 研究员画像（按 (姓名,机构) 聚合防同名）
- keywords.json      逐年 Top40 标题热词（jieba TF-IDF；缺 jieba 时跳过并告警，不影响其余输出）

CLI：build_stats.py --repo-root .
"""

import argparse
import calendar
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

try:
    from jieba import analyse as jieba_analyse
except ImportError:
    jieba_analyse = None

TOP_INDUSTRIES = 30
TOP_ORGS = 50
TOP_RESEARCHERS = 50
TOP_KEYWORDS = 40

# 评级归一：实测全库 22 种评级名 → 5 档（分数用于情绪指数）。
# 空字符串 = 未评级（策略报告为主，占 44.4%），不计入情绪指数分母。
RATING_BUCKET = {
    "买入": "buy", "强烈推荐": "buy", "BUY": "buy", "谨慎买入": "buy",
    "增持": "add", "推荐": "add", "看好": "add", "强于大市": "add",
    "谨慎推荐": "add", "审慎推荐": "add", "谨慎增持": "add",
    "中性": "neutral", "持有": "neutral", "中立": "neutral",
    "同步大市": "neutral", "Equalweight(同步)": "neutral", "HOLD": "neutral",
    "减持": "reduce", "回避": "reduce",
    "卖出": "sell", "SELL": "sell", "沽出": "sell",
}
BUCKETS = ("buy", "add", "neutral", "reduce", "sell")
BUCKET_SCORE = {"buy": 1.0, "add": 0.5, "neutral": 0.0, "reduce": -0.5, "sell": -1.0}

# 标题热词过滤：报告体词/通用词停用表 + 数字年份正则（口径见 analysis/findings.md §7）
STOPWORDS = frozenset("""
点评 周报 日报 晨报 晨会 纪要 年报 中报 季报 月报 半年报 一季报 三季报 专题 深度 系列 跟踪 高频 动态 观察 速递 快评 简评
综述 盘点 回顾 前瞻 展望 观点 解读 思考 分析 研究 报告
行业 公司 市场 数据 策略 宏观 业绩 预期 符合 增长 同比 环比 维持 评级 首次 覆盖 关注 建议 布局
改善 稳健 承压 龙头 更新 每日 证券 投资 有限 股份 集团 盈利 收入 营收 净利 净利润 毛利 毛利率
估值 低于 高于 超预期 符合预期 推出 发布 推进 持续 加速 业务 板块 表现 影响 情况 有望 或将 重点 核心 看好 未来 空间 机会 方向
重视 财富 高增 景气 落地 修复 亮眼 驱动 提升 放量 归母 成长 韧性 赋能 助力 洞察 稳步 优化 聚焦 产业链 利润 回暖 向好 供需 政策 周期
红利 改革 创新 智能 生态 格局 趋势 专题报告 研究所 每周 周度 总第 卓越 短期 静待 发力 预告 释放 晨会纪要 内参 基础 词条 概览 日评
""".split())

NOISE_RE = re.compile(
    r"^[0-9.%+xX\-—–/]+$|^[Qq][1-4](度)?(财报)?$|^\d{2,4}年?$|^\d{2,4}[Qq][1-4](财报|季)?$"
    r"|^第[一二三四五六七八九十\d]+(周|天|季度|次|期)?$"
)


def _norm_kw(word):
    """返回合法化后的热词，不合格返回 None。"""
    w = word.strip()
    if len(w) < 2 or w in STOPWORDS:
        return None
    if NOISE_RE.match(w):
        return None
    if w.endswith("行业"):  # 行业名（行业维度已独立覆盖）
        return None
    return w


def _write_if_changed(path, obj):
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def _day_occurrences(first_ym, last_ym):
    """31 元素数组：occ[i] = 区间内含 i 号的月份数。"""
    y, m = int(first_ym[:4]), int(first_ym[5:7])
    y1, m1 = int(last_ym[:4]), int(last_ym[5:7])
    occ = [0] * 32
    while (y, m) <= (y1, m1):
        days = calendar.monthrange(y, m)[1]
        for d in range(1, days + 1):
            occ[d] += 1
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return occ


def build(repo_root):
    root = Path(repo_root)
    data_dir = common.data_dir(root)
    stats_dir = data_dir / "stats"
    stats_dir.mkdir(exist_ok=True)

    mon_total = Counter()
    mon_q = defaultdict(lambda: [0, 0, 0])
    mon_bucket = defaultdict(Counter)
    mon_score = defaultdict(float)
    mon_rated = Counter()

    ind_total = Counter()
    ind_month = defaultdict(Counter)  # industry -> month -> n

    weekday_c = Counter()
    moy_c = Counter()
    dom_c = Counter()

    org = defaultdict(lambda: {"total": 0, "rated": 0, "buy": 0,
                               "inds": set(), "stocks": set(), "people": set(),
                               "pages_sum": 0, "pages_n": 0})
    person = defaultdict(lambda: {"total": 0, "inds": set(), "stocks": set(), "collabs": set()})
    kw_year = defaultdict(Counter)

    unknown_ratings = Counter()
    total = 0
    pages_sum = pages_n = 0
    first_date = last_date = None

    for p in sorted(data_dir.glob("reports-*.json")):
        for rec in common.read_shard(p):
            total += 1
            d = (rec.get("publishDate") or "").strip()
            if len(d) < 10:
                continue
            ym = d[:7]
            y, m, dd = int(d[:4]), int(d[5:7]), int(d[8:10])
            if first_date is None or d < first_date:
                first_date = d
            if last_date is None or d > last_date:
                last_date = d

            mon_total[ym] += 1
            qt = rec.get("qType")
            if qt in (0, 1, 2):
                mon_q[ym][qt] += 1

            rating = (rec.get("emRatingName") or "").strip() or (rec.get("sRatingName") or "").strip()
            bucket = None
            if rating:
                bucket = RATING_BUCKET.get(rating)
                if bucket is None:
                    unknown_ratings[rating] += 1
                else:
                    mon_bucket[ym][bucket] += 1
                    mon_rated[ym] += 1
                    mon_score[ym] += BUCKET_SCORE[bucket]

            ind = (rec.get("industryName") or "").strip()
            if ind:
                ind_total[ind] += 1
                ind_month[ind][ym] += 1

            weekday_c[date(y, m, dd).weekday()] += 1
            moy_c[m] += 1
            dom_c[dd] += 1

            stock = (rec.get("stockName") or "").strip()
            pages = rec.get("attachPages")
            if pages:
                pages_sum += pages
                pages_n += 1

            org_name = (rec.get("orgSName") or "").strip()
            if org_name:
                o = org[org_name]
                o["total"] += 1
                if bucket:
                    o["rated"] += 1
                    if bucket == "buy":
                        o["buy"] += 1
                if ind:
                    o["inds"].add(ind)
                if stock:
                    o["stocks"].add(stock)
                if pages:
                    o["pages_sum"] += pages
                    o["pages_n"] += 1
            else:
                o = None

            researcher = (rec.get("researcher") or "").strip()
            people = [x.strip() for x in researcher.split(",") if x.strip()]
            if o is not None:
                o["people"].update(people)
            for name in people:
                pr = person[(name, org_name)]
                pr["total"] += 1
                if ind:
                    pr["inds"].add(ind)
                if stock:
                    pr["stocks"].add(stock)
                pr["collabs"].update(x for x in people if x != name)

            if jieba_analyse is not None:
                title = (rec.get("title") or "").strip()
                if title:
                    for w in jieba_analyse.extract_tags(title, topK=6):
                        w = _norm_kw(w)
                        if w:
                            kw_year[str(y)][w] += 1

    # ---------- 汇总输出 ----------
    yms = sorted(mon_total)

    monthly = {
        "months": yms,
        "total": [mon_total[m] for m in yms],
        "qtype": {"q0": [mon_q[m][0] for m in yms],
                  "q1": [mon_q[m][1] for m in yms],
                  "q2": [mon_q[m][2] for m in yms]},
        "rating": {b: [mon_bucket[m][b] for m in yms] for b in BUCKETS},
        "sentiment": [round(mon_score[m] / mon_rated[m], 3) if mon_rated[m] else None for m in yms],
        "buy_pct": [round(mon_bucket[m]["buy"] * 100.0 / mon_rated[m], 1) if mon_rated[m] else None for m in yms],
    }

    top_inds = [name for name, _ in ind_total.most_common(TOP_INDUSTRIES)]
    heatmap = {
        "months": yms,
        "industries": top_inds,
        "matrix": [[ind_month[ind].get(m, 0) for m in yms] for ind in top_inds],
    }

    occ = _day_occurrences(yms[0], yms[-1])
    timepatterns = {
        "weekday": {"labels": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                    "counts": [weekday_c[i] for i in range(7)]},
        "month_of_year": {"labels": [f"{m}月" for m in range(1, 13)],
                          "counts": [moy_c[m] for m in range(1, 13)]},
        "day_of_month": {"labels": [f"{d}日" for d in range(1, 32)],
                         "counts": [dom_c[d] for d in range(1, 32)],
                         "per_occurrence": [round(dom_c[d] / occ[d], 1) if occ[d] else None for d in range(1, 32)]},
    }

    orgs_out = []
    for name, o in sorted(org.items(), key=lambda kv: (-kv[1]["total"], kv[0]))[:TOP_ORGS]:
        orgs_out.append({
            "name": name, "total": o["total"], "rated": o["rated"],
            "buy_pct": round(o["buy"] * 100.0 / o["rated"], 1) if o["rated"] else None,
            "inds": len(o["inds"]), "stocks": len(o["stocks"]), "researchers": len(o["people"]),
            "avg_pages": round(o["pages_sum"] / o["pages_n"], 1) if o["pages_n"] else None,
        })

    researchers_out = []
    for (name, org_name), pr in sorted(person.items(), key=lambda kv: (-kv[1]["total"], kv[0]))[:TOP_RESEARCHERS]:
        researchers_out.append({
            "name": name, "org": org_name, "total": pr["total"],
            "inds": len(pr["inds"]), "stocks": len(pr["stocks"]), "collabs": len(pr["collabs"]),
        })

    overview = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": total,
        "date_range": [first_date, last_date],
        "months": len(yms),
        "orgs": len(org),
        "industries": len(ind_total),
        "researchers": len(person),
        "stocks": len({s for o in org.values() for s in o["stocks"]}),
        "rated": sum(mon_rated.values()),
        "avg_pages": round(pages_sum / pages_n, 1) if pages_n else None,
    }

    changed = []
    for fname, obj in [
        ("overview.json", overview),
        ("monthly.json", monthly),
        ("heatmap.json", heatmap),
        ("timepatterns.json", timepatterns),
        ("orgs.json", orgs_out),
        ("researchers.json", researchers_out),
    ]:
        if _write_if_changed(stats_dir / fname, obj):
            changed.append(fname)

    if jieba_analyse is not None:
        ind_names = set(ind_total)  # 行业名已从行业维度独立覆盖，热词中剔除
        org_frags = set()
        for name in org:  # 机构名及去尾缀片段（粤开证券→粤开），剔除报告系列名混入
            org_frags.add(name)
            for suf in ("证券", "期货", "基金", "资管", "研究院"):
                if name.endswith(suf) and len(name) > len(suf):
                    org_frags.add(name[:-len(suf)])
        drop = ind_names | org_frags
        keywords = {
            "years": sorted(kw_year, reverse=True),
            "words": {yr: [[w, c] for w, c in
                           ((w, c) for w, c in kw_year[yr].most_common() if w not in drop)][:TOP_KEYWORDS]
                      for yr in sorted(kw_year, reverse=True)},
        }
        if _write_if_changed(stats_dir / "keywords.json", keywords):
            changed.append("keywords.json")
    else:
        print("WARNING: 未安装 jieba，跳过 keywords.json（pip install jieba 后可生成）")

    print(f"stats: {total} reports, {len(yms)} months -> {stats_dir} "
          f"({'changed: ' + ', '.join(changed) if changed else 'no changes'})")
    if unknown_ratings:
        print(f"WARNING: 未知评级名 {sum(unknown_ratings.values())} 条，请补充 RATING_BUCKET: {dict(unknown_ratings.most_common(10))}")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".")
    args = ap.parse_args()
    build(args.repo_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
