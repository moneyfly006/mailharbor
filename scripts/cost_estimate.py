#!/usr/bin/env python3
"""MailHarbor 报价 / 成本估算器。

读 cost/costs.json → 计算并打印：
  1) 设计费（按人天×单价，三种交付方）
  2) 开发费（AI 协作 / 人力外包 / 自建团队）
  3) Token 消耗与费用（按模型档位）
  4) ROI（省下的人工成本 / 回本周期）
可选：--html 生成一份可交互的报价单 cost/quote.html

用法:
  python3 scripts/cost_estimate.py
  python3 scripts/cost_estimate.py --html
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "cost" / "costs.json").read_text(encoding="utf-8"))
USD_CNY = 7.2


def days(phase: str) -> tuple[float, float]:
    ai = sum(v.get("ai_days", 0) for v in CFG["scope"][phase].values())
    human = sum(v.get("human_days", 0) for v in CFG["scope"][phase].values())
    return ai, human


def fmt_money(v: float, unit: str = "元") -> str:
    if v >= 10000:
        return f"{v/10000:.2f} 万{unit}"
    return f"{v:,.0f} {unit}"


def main() -> int:
    out = []
    P = out.append

    ai_d, human_d = days("design")
    dev_ai_d, dev_human_d = days("dev")
    P("=" * 78)
    P("MailHarbor 软件设计 + 开发 成本估算（人民币，2026-11 国内市场价格口径）")
    P("=" * 78)
    P("")

    # ---------- 1. 工作量 ----------
    P("【1】工作量拆解（人天）")
    P(f"  设计阶段：AI 协作 {ai_d:.2f} 人天 / 传统人力 {human_d:.0f} 人天")
    for k, v in CFG["scope"]["design"].items():
        P(f"    - {k:<46s} AI {v.get('ai_days',0):>4.2f} / 人力 {v.get('human_days',0):>4.0f}")
    P(f"  开发阶段：AI 协作 {dev_ai_d:.2f} 人天 / 传统人力 {dev_human_d:.0f} 人天")
    for k, v in CFG["scope"]["dev"].items():
        P(f"    - {k[:44]:<46s} AI {v.get('ai_days',0):>4.2f} / 人力 {v.get('human_days',0):>4.0f}")
    total_ai = ai_d + dev_ai_d
    total_human = human_d + dev_human_d
    P(f"  ── 合计：AI 协作 {total_ai:.2f} 人天 / 传统人力 {total_human:.0f} 人天（约 {total_human/21.7:.1f} 人月）")
    P("")

    # ---------- 2. 设计费 ----------
    P("【2】设计费（需求分析 + 架构 + 6 屏设计 + 设计规范 + 可点击原型 + 客户修订）")
    P(f"  设计师工作量 {human_d:.0f} 人天（约 {human_d/21.7:.1f} 人月）；下表为「找外部设计」的市场价：")
    for name, r in CFG["rates"]["market"].items():
        lo, hi = r["range"]
        P(f"  {name:<24s} 单价 {lo:>5,}–{hi:>5,} 元/人天  →  设计费 {fmt_money(human_d*lo)} – {fmt_money(human_d*hi)}")
    P(f"  若按「设计包」一口价卖：{fmt_money(human_d*1200)} – {fmt_money(human_d*2200)}（6 屏 + 规范 + 说明书 PDF）")
    P(f"  AI 路线设计费（1 人 + AI，按 {CFG['rates']['ai']['人机协作（1 人 + AI，AI 承担大部分编码）']['day']} 元/人天 × {ai_d:.1f} AI 人天）"
      f"≈ {fmt_money(ai_d*CFG['rates']['ai']['人机协作（1 人 + AI，AI 承担大部分编码）']['day'])}")
    P("")

    # ---------- 3. 开发费 ----------
    P("【3】开发费（三个口径）")
    ai_rate = CFG["rates"]["ai"]["人机协作（1 人 + AI，AI 承担大部分编码）"]["day"]
    ai_days_exec = total_ai          # AI 代理执行的「等效开发日」
    human_effort = 21                # 人工投入（半天为单位，约 3 周 × 每天 1~1.5 小时，含验收/真机测试/沟通）
    P(f"  A. AI 人机协作路线（1 人 + AI 代理）")
    P(f"     · AI 代理执行：约 {ai_days_exec:.0f} 个等效开发日（折算日历约 10–12 天）")
    P(f"     · 人工投入：约 {human_effort} 个半天 ≈ {human_effort/2:.1f} 个工作日（约 3 周，每天 1–1.5 小时：需求确认、逐屏验收、真机测试、客户沟通）")
    P(f"     · 人工成本：{human_effort} 半天 × 350 元/半天 ≈ {fmt_money(human_effort*350)}（按 700 元/人天折算）")
    P(f"     · token 成本：见第 4 节（Flash ≈ ¥143，Pro ≈ ¥601）")
    P(f"     · 结论：现金支出 ≈ {fmt_money(human_effort*350 + 4500 + 143)} – {fmt_money(human_effort*350 + 4500 + 601)}（含测试机/签名）")
    for name, r in CFG["rates"]["market"].items():
        lo, hi = r["range"]
        P(f"  {'BCD'[list(CFG['rates']['market']).index(name)]}. {name}")
        P(f"     设计+开发 {total_human:.0f} 人天 × {lo:,}–{hi:,} 元/人天 = "
          f"{fmt_money(total_human*lo)} – {fmt_money(total_human*hi)}")
    P("")

    # ---------- 4. Token ----------
    P("【4】Token 消耗与费用（AI 路线）")
    P("  口径：一个任务会话 = 输入(读上下文) + 输出(写代码) + 缓存命中(重复读)")
    P("  实测参考：本机 DSH 历史 84 个会话累计 输入 1,218 万 / 输出 981 万 / 缓存读 31.6 亿，")
    P("            单会话均值 输入 14.5 万 / 输出 11.7 万 / 缓存读 3,760 万 —— 本估算取更保守的中位量级。")
    tint = tout = tcache = 0
    for k, v in CFG["tokens"]["per_phase"].items():
        i = v["sessions"] * v["in_per"]
        o = v["sessions"] * v["out_per"]
        c = v["sessions"] * v["cache_per"]
        tint += i
        tout += o
        tcache += c
        P(f"  - {k[:40]:<42s} {v['sessions']:>3d} 会话  输入 {i/1e6:>6.1f}M  输出 {o/1e6:>5.1f}M  缓存读 {c/1e6:>7.1f}M")
    P(f"  ── 合计：输入 {tint/1e6:.1f}M / 输出 {tout/1e6:.1f}M / 缓存读 {tcache/1e6:.0f}M"
      f"  ≈ 未计费等效 {((tint+tout+tcache)/1e6):.0f}M tokens")
    P("")
    P("  按档位计价（USD/1M：in / cache / out）：")
    for name, r in CFG["tokens"]["tiers"].items():
        usd = (tint/1e6*r["in"]) + (tcache/1e6*r["cache"]) + (tout/1e6*r["out"])
        P(f"    {name:<26s} ${usd:>8.2f}  ≈ ¥{usd*USD_CNY:>8,.0f}")
    P("  注：以上为「AI 代理从零写到交付」的全过程消耗；实际用 IDE 内置 AI（Cursor/Claude Code 订阅）")
    P("      则按订阅计费（$20–$200/月 × 2–3 个月 ≈ ¥300–¥4,300），成本更低但可控性差。")
    P("")

    # ---------- 5. 一次性成本 ----------
    P("【5】一次性与固定成本")
    one = 0.0
    for k, v in CFG["scope"]["post"].items():
        if "money" in v:
            one += v["money"]
            P(f"  - {k:<44s} {fmt_money(v['money'])}")
    P(f"  ── 小计：{fmt_money(one)}（测试机/签名证书按年计，可复用）")
    P("")

    # ---------- 6. 全包价 ----------
    P("【6】全包预算（设计 + 开发 + 一次性成本，不含长期维护）")
    ai_total = 21 * 350 + one
    P(f"  A. AI 人机协作全包：人工 {fmt_money(21*350)} + 固定 {fmt_money(one)} + token ¥143–601"
      f" ≈ {fmt_money(ai_total)}（现金支出）")
    P(f"     保守留 30% 缓冲（AI 返工、客户改需求）≈ {fmt_money(ai_total*1.3)}")
    for name, r in CFG["rates"]["market"].items():
        lo, hi = r["range"]
        P(f"  {name:<20s} {fmt_money(total_human*lo+one)} – {fmt_money(total_human*hi+one)}")
    P("")

    # ---------- 7. 自建团队 ----------
    P("【7】如果招人自己做（自建团队，1 个项目周期）")
    rate = CFG["rates"]["roles"]
    eng_m = total_human / 21.7
    P(f"  资深工程师 1 名 × {eng_m:.1f} 人月（{rate['资深 Electron/TS 工程师（≈5 年）']['month']:,} 元/月）= "
      f"{fmt_money(eng_m*rate['资深 Electron/TS 工程师（≈5 年）']['month'])}")
    des_m = human_d / 21.7
    P(f"  设计师 0.6 名 × {des_m:.1f} 人月 = {fmt_money(des_m*rate['UI/UX 设计师']['month']*0.6)}")
    P(f"  ＋招聘成本（猎头 1–2 个月薪）/ 社保公积金约 1.3 倍 / 管理成本  —— 实际比外包更贵，且只适用于长期有项目")
    P("")

    # ---------- 8. 长期维护 ----------
    P("【8】长期维护（第 2 年起，每年）")
    maint_days = CFG["scope"]["post"]["12 个月缺陷修复（约每月 1.5 人天）"]["human_days"] + \
                 CFG["scope"]["post"]["12 个月小版本迭代（新版式/新字段等，按 8 人天）"]["human_days"]
    P(f"  缺陷修复 + 小版本迭代 ≈ {maint_days} 人天/年 → 市场价 {fmt_money(maint_days*900)} – {fmt_money(maint_days*2200)}/年")
    P("  （AI 协作模式下约 6–10 人天/年，含邮箱服务商策略变化适配）")
    P("")

    # ---------- 9. ROI ----------
    P("【9】值不值：回本测算")
    for emails, mins in [(60, 2), (100, 2), (200, 1.5)]:
        h_day = emails * mins / 60
        h_year = h_day * 300
        save = h_year * 45  # 按 45 元/小时综合人力成本
        P(f"  {emails:>3d} 封/天 × {mins} 分钟/封 → 每年省 {h_year:,.0f} 小时 ≈ {fmt_money(save)}/年"
          f"  → 按 AI 全包 {fmt_money(ai_total*1.3)} 计，回本 {ai_total*1.3/save*12:.1f} 个月")
    P("")

    # ---------- 10. 建议 ----------
    P("【10】建议的报价与付款节奏")
    P("  推荐对客户报「一口价」（AI 路线现金成本 ≈ 1.2–1.6 万，建议报价 5.8–7.8 万，覆盖 2–3 轮改需求与 12 个月质保）：")
    P(f"    设计（已完成：需求+6屏+规范+说明书）        1.3 万")
    P(f"    开发 + 部署 + 验收 + 12 个月质保             4.5–6.5 万")
    P(f"    合计建议报价 ≈ 5.8 万 – 7.8 万（可议；对客户不提 AI 占比，按交付物和工期谈）")
    P("  付款：签约 30% / 原型确认 30% / 真机验收 30% / 上线 7 天后 10%")
    P("")

    report = "\n".join(out)
    print(report)
    (ROOT / "cost" / "estimate.txt").write_text(report, encoding="utf-8")
    print(f"\n[已写入] {ROOT/'cost'/'estimate.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
