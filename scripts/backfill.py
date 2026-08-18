#!/usr/bin/env python3
"""历史回填：遍历 月份×qType（2017-01 → 当前月 × qType 0/1/2，共 345 单元），
pageSize=100 循环至 TotalPage，请求间隔 1s，断点续跑（state.json），
每 ~10 单元 commit+push 一次，失败单元记清单不阻塞。

契约（详见仓库 README / 内部 plan）：
- 保留 15 字段：title/orgName/orgSName/infoCode/publishDate/industryName/
  emRatingName/sRatingName/researcher/stockName/stockCode/attachPages/qType
  + 扩展预留 encodeUrl/attachSize
- 单请求 3 次指数退避重试
- 月内按 infoCode 去重，每条记录独立一行存储
"""

import sys


def main() -> int:
    print("TODO(M1): not implemented yet", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
