# reportlists

PDF 研报元数据展示站：抓取东方财富研报中心（个股 / 行业 / 策略，2017 至今，约 43 万条），生成静态数据分片 + 标签索引，部署于 Cloudflare Pages。

- 站点：<https://reportlists.pages.dev>
- 数据源：`reportapi.eastmoney.com/report/list`（元数据，无密钥）
- PDF 查看：点击条目直跳 `pdf.dfcfw.com` 原链（外链模式，不自托管）

## 架构

```
GitHub Actions（每日增量 + 手动回填灾备）
  → scripts/ 抓取并裁剪 15 字段 → site/data/ 按月分片 + 标签/索引
  → change-only commit → wrangler pages deploy
前端：site/index.html + vanilla JS（无构建，分片懒加载 + 多维筛选 + 搜索）
```

## 目录结构

```
.github/workflows/   update-daily.yml（每日增量+部署）/ backfill.yml（历史回填灾备）
scripts/             fetch_reports.py / backfill.py / build_index.py
site/                index.html + app.js + style.css + data/（生成物）
```

## 状态

M1 数据管道 + M2 前端站点已完成（2026-08-19，本地 + CI + 线上全链路验证）：

- [x] fetch_reports.py：每日增量（北京时间昨天）、JSONP 兼容、周末零数据豁免
- [x] backfill.py：15 字段裁剪、1s 间隔、state.json 断点续跑、每 10 单元 commit、失败清单、顺序分批 `--max-units 35`
- [x] build_index.py：tags.json（5 维度 + years 元数据）+ index-YYYY.json（按年搜索索引）
- [x] update-daily.yml：cron 08:00 UTC + push 触发 + change-only 部署（concurrency 串行 + pull --rebase 防竞态）
- [x] 全量历史回填：348 单元 0 失败，433,585 条（2017-01 → 2026-08），116 分片
- [x] 前端：日期倒序列表 / 标签云（行业/机构/评级/研究员/个股）/ 多维组合筛选 / 搜索（自动扩围近 1 年，可选全库）/ 月份分片懒加载 / hash 状态分享 / 移动端适配

M3 打磨（SEO sitemap、统计页）待开发。

## License

Data belongs to its original publishers (East Money / brokerages). This repo hosts metadata + outbound links only.
