#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信历史导出兼容入口。

给 `node scripts/learn-style.js --source export` 准备输入：
    python scripts/export-wechat-history.py --out data/wechat-history.json

只读取本地数据库，不修改 vendor/。需要微信 4.x 的数据库密钥（由 wechatauto
自己处理）；找不到库或没有权限时给出可读错误并以非 0 退出。
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for extra in (ROOT, os.path.join(ROOT, "vendor"), os.path.join(ROOT, "bridge")):
    if extra not in sys.path:
        sys.path.insert(0, extra)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="导出微信聊天记录为 JSON（wechatauto export_history 兼容入口）"
    )
    parser.add_argument("--out", required=True, help="输出 JSON 文件路径")
    parser.add_argument(
        "--limit", type=int, default=2000,
        help="每个会话最多导出多少条（默认 2000，按时间保留最新）",
    )
    parser.add_argument("--account", default="", help="账号目录名 / wxid / 昵称（默认自动选最近活跃账号）")
    parser.add_argument("--db-dir", dest="db_dir", default="", help="微信数据库根目录（默认自动探测）")
    return parser.parse_args(argv)


def fail(message, code=1):
    print(message, file=sys.stderr)
    return code


def main(argv=None):
    args = parse_args(argv)
    out_path = os.path.abspath(os.path.expanduser(args.out))
    limit = max(1, int(args.limit or 2000))

    try:
        from bridge.wechat_db import resolve_db_dir, resolve_account_dir
        from wechatauto import WeChatDB
    except Exception as exc:  # 缺 vendor / 依赖 / 运行环境
        return fail(
            "无法加载 wechatauto：%s\n"
            "请确认已安装 requirements.txt 里的依赖，并从仓库根目录运行本脚本。" % exc,
            2,
        )

    config_path = os.path.join(ROOT, "data", "config.json")
    if not os.path.exists(config_path):
        config_path = os.path.join(ROOT, "config.json")
    db_dir = args.db_dir or resolve_db_dir(
        config_path=config_path, default_config_path=config_path
    )
    if not db_dir:
        return fail(
            "找不到微信数据库目录。请确认微信已登录，或在 config.json 的 "
            "wechat.dbDir 里填入数据目录，或使用 --db-dir 指定。",
            2,
        )

    account = ""
    if args.account:
        account = resolve_account_dir(db_dir, args.account)
        if not account:
            return fail("在数据库目录里找不到账号：%s" % args.account, 2)

    out_dir = os.path.dirname(out_path)
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as exc:
            return fail("无法创建输出目录：%s" % exc, 2)

    try:
        db = WeChatDB(db_dir=db_dir, account=account or None)
        result = db.export_history(out_path, fmt="json", limit_per_chat=limit)
    except PermissionError as exc:
        return fail(
            "没有权限读取微信数据库：%s\n"
            "请确认微信已登录、没有被安全软件拦截，并且本脚本与微信运行在同一用户下。" % exc,
            2,
        )
    except Exception as exc:
        return fail("导出失败（%s）：%s" % (type(exc).__name__, exc), 1)

    chats = int((result or {}).get("chats") or 0)
    messages = int((result or {}).get("messages") or 0)
    print("会话数：%d" % chats)
    print("消息数：%d" % messages)
    print("输出：%s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
