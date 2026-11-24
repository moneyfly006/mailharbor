#!/usr/bin/env python3
"""把 docs/gmail-setup.html 打印成 A4 PDF：docs/邮箱资料助手-Gmail加速配置指南.pdf"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'docs' / 'gmail-setup.html'
OUT = ROOT / 'docs' / '邮箱资料助手-Gmail加速配置指南.pdf'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

with sync_playwright() as p:
    try:
        b = p.chromium.launch(channel='chrome')
    except Exception:
        b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page()
    pg.goto(SRC.resolve().as_uri(), wait_until='networkidle')
    pg.wait_for_timeout(1200)
    pg.emulate_media(media='print')
    pg.wait_for_timeout(300)
    pg.pdf(path=str(OUT), format='A4', print_background=True,
           margin={'top': '16mm', 'bottom': '14mm', 'left': '15mm', 'right': '15mm'})
    height = pg.evaluate('document.documentElement.scrollHeight')
    b.close()
print(f'PDF: {OUT}  height={height}px  size={OUT.stat().st_size/1e6:.1f}MB')
