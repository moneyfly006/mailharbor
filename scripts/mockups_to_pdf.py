#!/usr/bin/env python3
"""把 design/exports/*.png 合成一份可直接发给客户的 PDF 设计说明书。

用法: python3 scripts/mockups_to_pdf.py
输出: design/exports/MailHarbor-设计说明书.pdf   （封面 + 每屏一页，A4 横向）

原理：生成排好版的 HTML（每屏一页、页内锁定 277×173mm 图框）→ Chrome 打印 PDF。
不依赖 reportlab；改文案只需改下面的 PAGES。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "exports"
OUT = ROOT / "docs" / "邮箱资料助手-设计说明书.pdf"

PAGES = [
    ("01-dashboard", "概览 · 今天有没有在干活",
     "操作员每天上班只看这一屏：软件在不在跑、邮箱通不通、今天收了多少件、哪些盘快满了、最近收到的是什么。异常用橙色提示，不弹窗打断。"),
    ("02-accounts", "邮箱账户 · 填参数就能用，不搞授权",
     "客户明确要求「用 SMTP，不要授权」。所以这里是熟悉的邮箱参数表单：服务商预设 → 收件 IMAP（主机/端口/加密/账号/应用专用密码）+ 发件 SMTP → 一键测试连接（IMAP ✔ / SMTP ✔ 分别验证）→ 保存启用。说明：SMTP 只负责发信，收信必须另外配 IMAP。邮箱不写死，随时改、随时停。"),
    ("03-rules", "触发规则 · 什么单、进哪个夹子（核心）",
     "整套软件的大脑。左边是关键词清单（出厂预设「原图+手机壳 / 原图+卡套 / 原图+浴室垫」，可新增、可删除、可停用），右边编辑选中规则：匹配方式、目标路径 1~N 条、附件类型、是否回信。「原图+卡套」这一条就配了两个路径——生产盘和备份盘。"),
    ("04-autoreply", "自动回复 · 让客户安心",
     "只有必达路径全部落盘成功才回信，同一线程只回一次，避免客户收到重复邮件。模板中英文可切换，变量点一下就插入，右侧是真实邮件样子。"),
    ("05-records", "下载记录 · 出问题找得到件",
     "每一封邮件、每个附件、每个目标路径都留痕。两个路径都成功就是两个绿勾；备份盘挂了就红叉 + 原因，点「重试」只补那一份，成功的路径不会重复写。"),
    ("06-components", "组件与状态 · 交给开发照着做",
     "按钮、输入框、开关、徽章、表格、Toast、空状态、托盘菜单的完整状态表，保证后续实现与设计图一致。"),
]

HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page {{ size: A4 landscape; margin: 9mm; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  html, body {{ margin:0; padding:0; font-family:"Songti SC","PingFang SC","Hiragino Sans GB",serif; color:#16202B; background:#FAF7F0; }}
  .page {{ width:279mm; height:192mm; padding:4mm 2mm 2mm; page-break-after:always; break-after:page;
           display:flex; flex-direction:column; overflow:hidden; }}
  .page:last-child {{ page-break-after:auto; break-after:auto; }}
  .cover {{ justify-content:center; padding-left:14mm; background:#FAF7F0; }}
  .kicker {{ font-family:"SF Mono",ui-monospace,monospace; font-size:10pt; letter-spacing:.34em; color:#C8422D; }}
  h1 {{ font-size:40pt; margin:9mm 0 5mm; line-height:1.2; font-weight:600; }}
  h1 em {{ font-style:normal; color:#C8422D; }}
  .sub {{ font-size:12.5pt; color:#4A5561; max-width:196mm; line-height:1.85; }}
  .meta {{ margin-top:14mm; font-size:9pt; color:#7C858F; border-top:1px solid #E5DDCC; padding-top:4mm; letter-spacing:.06em; }}
  .phead {{ display:flex; align-items:baseline; gap:6mm; flex:none; }}
  .pnum {{ font-family:"SF Mono",ui-monospace,monospace; font-size:9pt; color:#C8422D; letter-spacing:.18em; }}
  h2 {{ font-size:15pt; margin:0; font-weight:600; letter-spacing:.01em; }}
  .desc {{ font-size:9.2pt; color:#4A5561; line-height:1.6; margin:2mm 0 3mm; flex:none; }}
  .shotwrap {{ flex:1; min-height:0; display:flex; align-items:center; justify-content:center; }}
  .shotwrap img {{ max-width:100%; max-height:100%; display:block; border:1px solid #D8CEBA; border-radius:2px; }}
  .pfoot {{ flex:none; display:flex; justify-content:space-between; font-family:"SF Mono",ui-monospace,monospace;
            font-size:7.6pt; color:#A6ADB5; letter-spacing:.08em; padding-top:1.5mm; }}
</style></head><body>
<div class="page cover">
  <div class="kicker">邮箱资料助手 · E-MAIL ARTWORK ARCHIVER</div>
  <h1>客户发来的图稿，<br>自己<em>落进该去的文件夹</em>。</h1>
  <div class="sub">Windows 桌面软件高保真设计图（v0.3）。通过 <b>IMAP 收信</b> 盯住工厂邮箱 → 按邮件标题关键词判断是否入库 → 把 ZIP / TIF 附件复制到一个或多个本地文件夹 → 通过 <b>SMTP 回信</b>告诉客户「已收到」。不上传任何图稿，密码只存在本机。</div>
  <div class="meta">版本 v0.3（关键词规则 · 一文件多路径 · IMAP/SMTP 收信发信）· 2026-11-22 · {n} 屏 · 设计基准 1440×900</div>
</div>
{pages}
</body></html>"""

PAGE = """<div class="page">
  <div class="phead"><span class="pnum">{num}</span><h2>{title}</h2></div>
  <p class="desc">{desc}</p>
  <div class="shotwrap"><img src="{src}" alt="{title}"></div>
  <div class="pfoot"><span>邮箱资料助手 · 设计说明书 v0.3</span><span>{num} / {total}</span></div>
</div>"""


def main() -> int:
    items = [p for p in PAGES if (SRC / f"{p[0]}.png").exists()]
    if not items:
        print("没有可用 PNG，先运行 scripts/render.py")
        return 1
    total = len(items)
    blocks = [
        PAGE.format(num=f"{i:02d}", total=f"{total:02d}", title=t, desc=d,
                    src=(SRC / f"{s}.png").resolve().as_uri())
        for i, (s, t, d) in enumerate(items, 1)
    ]
    html = HTML.format(n=total, pages="\n".join(blocks))
    tmp = SRC / "_spec.html"
    tmp.write_text(html, encoding="utf-8")

    from playwright.sync_api import sync_playwright

    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="chrome")
        except Exception:
            b = p.chromium.launch(executable_path=CHROME)
        pg = b.new_page()
        pg.goto(tmp.resolve().as_uri(), wait_until="networkidle")
        pg.wait_for_timeout(600)
        pg.emulate_media(media="print")
        pg.wait_for_timeout(200)
        pg.pdf(path=str(OUT), format="A4", landscape=True, print_background=True,
               margin={"top": "9mm", "bottom": "9mm", "left": "9mm", "right": "9mm"})
        b.close()
    print(f"PDF: {OUT}（封面 + {total} 屏）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
