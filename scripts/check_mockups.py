#!/usr/bin/env python3
"""设计稿自检：检查 mockups 是否存在外网依赖、必备文案/状态是否齐、并给出渲染尺寸。

用法: python3 scripts/check_mockups.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCREENS = ROOT / "design" / "mockups" / "screens"

REQUIRED = {
    "01-dashboard.html": ["监听", "今日", "剩余", "概览"],
    "02-accounts.html": ["授权", "Gmail"],
    "03-rules.html": ["原图+手机壳", "原图+卡套", "原图+浴室垫", "路径", "新增"],
    "04-autoreply.html": ["模板", "回信"],
    "05-records.html": ["记录", "失败"],
}

# 禁止的外网依赖
BAD = [
    (r"https?://(?!127\.0\.0\.1)[^\"'\s>)]+\.(css|js|woff2?|ttf|otf)", "外链字体/脚本"),
    (r"@import\s+url\(", "@import 外部样式"),
    (r"<link[^>]+href=\"https?://", "外链 <link>"),
    (r"<script[^>]+src=\"https?://", "外链 <script>"),
    (r"purple|#8b5cf6|#a855f7|linear-gradient\(.*purple", "紫色渐变(禁用)"),
]


def main() -> int:
    if not SCREENS.exists():
        print(f"缺少目录: {SCREENS}")
        return 1
    files = sorted(SCREENS.glob("*.html"))
    if not files:
        print("还没有设计稿")
        return 1
    fails = 0
    for f in files:
        src = f.read_text(encoding="utf-8", errors="ignore")
        problems = []
        for pat, label in BAD:
            m = re.search(pat, src, re.I)
            if m:
                problems.append(f"{label}: {m.group(0)[:80]}")
        for kw in REQUIRED.get(f.name, []):
            if kw not in src:
                problems.append(f"缺少必备文案/状态: {kw}")
        w = re.search(r"width\s*[:=]\s*['\"]?(\d+)", src)
        status = "OK " if not problems else "WARN"
        if problems:
            fails += 1
        print(f"[{status}] {f.name:26s} {len(src):>7} chars  第一屏宽:{w.group(1) if w else '?'}")
        for p in problems:
            print(f"        - {p}")
    print(f"\n{len(files)} 个文件，{fails} 个需要处理")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
