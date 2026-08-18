#!/usr/bin/env python3
"""每日增量抓取：拉取前一天 qType=0/1/2 研报列表，裁剪 15 字段，
合并进 site/data/reports-YYYY-MM.json（按 infoCode 去重、publishDate 排序、每条一行）。

契约（详见仓库 README / 内部 plan）：
- 请求头必须带 User-Agent 与 Referer: https://data.eastmoney.com/
- 响应可能为 JSONP（datatable(...)），需正则提取括号内 JSON
- 健康检查：请求失败或空数据时以非零码退出（CI 据此跳过部署）
"""

import sys


def main() -> int:
    print("TODO(M1): not implemented yet", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
