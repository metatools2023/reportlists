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

M1 数据管道开发中（见任务清单）：

- [ ] fetch_reports.py：列表抓取、JSONP 兼容、增量合并、按月分片
- [ ] backfill.py：15 字段裁剪、1s 间隔、断点续跑、失败清单（本地优先运行）
- [ ] build_index.py：tags.json + index-YYYY.json
- [ ] update-daily.yml：每日 cron + push 触发 + change-only 部署
- [ ] smoke test 全链路

## License

Data belongs to its original publishers (East Money / brokerages). This repo hosts metadata + outbound links only.
