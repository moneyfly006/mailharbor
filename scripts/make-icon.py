#!/usr/bin/env python3
"""生成「邮箱资料助手」应用图标（1024 PNG + 多尺寸 ICO + 托盘图标）。

图形：朱红圆角底 + 白色信封（V 形封口）+ 右上角探出的图稿纸（折角 + 图片符号）。
含义：邮件里收到图稿 → 自动归档。小尺寸下先看得清「信封」，再看清「纸」。
"""
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'resources'
RES.mkdir(exist_ok=True)

S = 2048
BRAND = (200, 66, 45)
BRAND_DARK = (156, 47, 32)
PAPER = (253, 251, 246)
INK = (22, 32, 43)
AMBER = (214, 158, 58)
RED2 = (168, 51, 33)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
pad = int(S * 0.06)
radius = int(S * 0.225)

# --- 底：圆角方形，竖向渐变（用遮罩裁剪，避免溢出圆角） ---
base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(base)
for y in range(S):
    t = y / S
    color = tuple(int(BRAND[i] * (1 - t * 0.35) + BRAND_DARK[i] * (t * 0.35)) for i in range(3))
    bd.line([0, y, S, y], fill=(*color, 255))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)
img.paste(base, (0, 0), mask)
d = ImageDraw.Draw(img)

# 内描边，小尺寸更清晰
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, outline=(*INK, 60), width=int(S * 0.007))

# --- 图稿纸（右上，部分藏在信封后） ---
pw, ph = int(S * 0.40), int(S * 0.46)
px, py = int(S * 0.50), int(S * 0.17)
fold = int(S * 0.085)
# 阴影
d.rounded_rectangle([px + int(S * 0.012), py + int(S * 0.012), px + pw + int(S * 0.012), py + ph + int(S * 0.012)],
                    radius=int(S * 0.02), fill=(*INK, 70))
# 纸
d.rounded_rectangle([px, py, px + pw, py + ph], radius=int(S * 0.018), fill=PAPER)
# 折角
d.polygon([(px + pw - fold, py), (px + pw, py + fold), (px + pw - fold, py + fold)], fill=(228, 222, 207))
d.line([(px + pw - fold, py), (px + pw - fold, py + fold), (px + pw, py + fold)],
       fill=(*INK, 45), width=int(S * 0.004))

# 纸上的图片符号：画框 + 山 + 太阳
mx, my = px + int(pw * 0.16), py + int(ph * 0.34)
mw, mh = int(pw * 0.68), int(ph * 0.40)
d.rounded_rectangle([mx, my, mx + mw, my + mh], radius=int(S * 0.012), fill=(238, 234, 222))
d.ellipse([mx + mw * 0.68, my + int(mh * 0.12), mx + mw * 0.88, my + int(mh * 0.36)], fill=AMBER)
d.polygon([(mx + int(mw * 0.06), my + mh), (mx + int(mw * 0.42), my + int(mh * 0.34)), (mx + int(mw * 0.72), my + mh)], fill=RED2)
d.polygon([(mx + int(mw * 0.50), my + mh), (mx + int(mw * 0.74), my + int(mh * 0.55)), (mx + mw, my + mh)], fill=(120, 40, 30))

# --- 信封（左下，主体） ---
ex0, ey0 = int(S * 0.13), int(S * 0.40)
ex1, ey1 = int(S * 0.75), int(S * 0.81)
er = int(S * 0.045)
# 阴影
d.rounded_rectangle([ex0 + int(S * 0.015), ey0 + int(S * 0.02), ex1 + int(S * 0.015), ey1 + int(S * 0.02)],
                    radius=er, fill=(*INK, 80))
# 信封主体
d.rounded_rectangle([ex0, ey0, ex1, ey1], radius=er, fill=PAPER)
# 封口 V（只在上半部分）
vtop = ey0 + int(S * 0.006)
vbottom = ey0 + int((ey1 - ey0) * 0.52)
d.line([(ex0 + er, vtop), ((ex0 + ex1) // 2, vbottom), (ex1 - er, vtop)],
       fill=(*INK, 150), width=int(S * 0.016), joint='curve')
# 信封边缘
d.rounded_rectangle([ex0, ey0, ex1, ey1], radius=er, outline=(*INK, 45), width=int(S * 0.005))

# --- 导出 ---
big = img.resize((1024, 1024), Image.LANCZOS)
big.save(RES / 'icon.png')
big.resize((512, 512), Image.LANCZOS).save(RES / 'icon-512.png')
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
big.resize((256, 256), Image.LANCZOS).save(RES / 'icon.ico', sizes=sizes)

# 托盘：小尺寸只留信封 + 朱红底
for size in (16, 32, 64):
    T = size * 8
    t = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    td = ImageDraw.Draw(t)
    td.rounded_rectangle([0, 0, T - 1, T - 1], radius=int(T * 0.22), fill=BRAND)
    m = int(T * 0.18)
    td.rounded_rectangle([m, int(T * 0.3), T - m, int(T * 0.74)], radius=int(T * 0.06), fill=PAPER)
    td.line([(m + int(T * 0.02), int(T * 0.32)), (T // 2, int(T * 0.55)), (T - m - int(T * 0.02), int(T * 0.32))],
            fill=(*INK, 200), width=max(2, int(T * 0.045)))
    t.resize((size, size), Image.LANCZOS).save(RES / f'tray{size}.png')
    if size == 32:
        t.resize((32, 32), Image.LANCZOS).save(RES / 'tray.png')

# 预览图（给设计说明/README 用）
preview = Image.new('RGB', (1200, 420), (250, 247, 240))
for i, s in enumerate([256, 128, 64, 48, 32, 16]):
    ic = big.resize((s, s), Image.LANCZOS)
    x = 60 + i * 190 if i < 5 else 60 + 5 * 190 + 40
    preview.paste(ic, (x, 90 + (256 - s) // 2), ic)
preview.save(ROOT / 'design' / 'exports' / 'app-icon-preview.png')
print('icon.png 1024 | icon.ico 256/128/64/48/32/16 | tray 16/32/64 | preview ok')
