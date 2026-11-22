#!/usr/bin/env python3
"""把 design/index.html（设计说明书网页）打印成 A4 横向 PDF，可直接发客户。

用法: python3 scripts/spec_to_pdf.py
输出: design/exports/MailHarbor-设计说明书-网页版.pdf
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "index.html"
OUT = ROOT / "design" / "exports" / "MailHarbor-设计说明书-网页版.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PRINT_CSS = """
@page { size: A4 landscape; margin: 9mm 9mm 9mm; }
.nav { display: none !important; }
.wrap { max-width: 1040px !important; padding: 0 26px !important; }
.hero { padding: 22px 0 20px !important; }
h1 { font-size: 30pt !important; }
h2 { font-size: 20pt !important; }
.lede { font-size: 12pt !important; }
section { padding: 18px 0 !important; }
.secdesc { margin-bottom: 18px !important; font-size: 10.5pt !important; }
/* 每屏一页：屏头 + 说明 + 截图三件套不拆页 */
.screen { page-break-inside: avoid; break-inside: avoid; margin-bottom: 14px !important; }
.screen .head { margin-bottom: 4px !important; }
.screen h3 { font-size: 17pt !important; }
.screen .about { font-size: 9.5pt !important; margin-bottom: 8px !important; line-height: 1.55 !important; }
.frame { padding: 6px !important; box-shadow: none !important; border-radius: 5px !important; }
.frame img { width: 100% !important; height: auto !important; }
/* 一屏一页的分页控制 */
.screen:nth-of-type(1) { page-break-before: always; }
.screen { page-break-after: always; }
.screen:last-of-type { page-break-after: auto; }
.flow, .states, .qs, .lang, table, .swatches, .principles { page-break-inside: avoid; break-inside: avoid; }
.flow { grid-template-columns: repeat(5,1fr) !important; }
.step { border-right: 1px solid rgba(22,32,43,.10) !important; border-bottom: 0 !important; }
.lang { grid-template-columns: 1.05fr 1fr !important; }
.states { grid-template-columns: repeat(4,1fr) !important; }
.qs { grid-template-columns: 1fr 1fr !important; }
.shot { grid-template-columns: 120px 1fr !important; }
.screen .idx { font-size: 8pt !important; }
"""


def main() -> int:
    if not SRC.exists():
        print("缺少 design/index.html")
        return 1
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="chrome")
        except Exception:
            b = p.chromium.launch(executable_path=CHROME)
        pg = b.new_page()
        pg.goto(SRC.resolve().as_uri(), wait_until="networkidle")
        pg.wait_for_timeout(900)
        pg.add_style_tag(content=PRINT_CSS)
        pg.emulate_media(media="print")
        pg.wait_for_timeout(300)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        pg.pdf(path=str(OUT), format="A4", landscape=True, print_background=True,
               margin={"top": "10mm", "bottom": "10mm", "left": "10mm", "right": "10mm"})
        pages = pg.evaluate("document.documentElement.scrollHeight")
        b.close()
    print(f"PDF: {OUT}\n页面高度: {pages}px")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
