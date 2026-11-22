#!/usr/bin/env python3
"""渲染 HTML 设计稿为 PNG（Chrome headless + Playwright）。

用法：
    python3 scripts/render.py design/mockups/screens/01-dashboard.html
    python3 scripts/render.py design/mockups/screens/          # 渲染目录下所有 html
    python3 scripts/render.py design/mockups/screens/01-dashboard.html --width 1440 --height 900 --scale 2

输出到 design/exports/<文件名>.png
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "design" / "exports"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def render(html_file: Path, width: int, height: int, scale: float, full_page: bool) -> Path:
    from playwright.sync_api import sync_playwright

    DEFAULT_OUT.mkdir(parents=True, exist_ok=True)
    out = DEFAULT_OUT / (html_file.stem + ".png")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            browser = p.chromium.launch(executable_path=CHROME)
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=scale)
        page.goto(html_file.resolve().as_uri(), wait_until="networkidle")
        page.wait_for_timeout(700)  # 字体/阴影稳定
        page.screenshot(path=str(out), full_page=full_page)
        browser.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="HTML 文件或目录")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--full-page", action="store_true")
    args = ap.parse_args()

    target = Path(args.target)
    if not target.is_absolute():
        target = (ROOT / target).resolve()
    files = sorted(target.glob("*.html")) if target.is_dir() else [target]
    if not files:
        print(f"没有找到 HTML: {target}", file=sys.stderr)
        return 1
    for f in files:
        print("rendered:", render(f, args.width, args.height, args.scale, args.full_page))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
