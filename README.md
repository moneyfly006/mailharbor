# MailHarbor · 邮件收货助手

> 给 POD（按需印刷定制）工厂用的 Windows 桌面软件：
> **IMAP 收信 → 按邮件标题关键词（如「原图+卡套」）判断要不要存 → 把 ZIP/TIF 附件复制到该关键词对应的一个或多个本地文件夹 → SMTP 回信告诉客户"已收到"。**

```
客户发邮件（标题「原图+卡套」，附件 POD_ORDER_20486.zip）
        │
        ▼
  ┌──────────────────────────────┐
  │  MailHarbor（托盘常驻 / 开机自启）│
  │  1. IMAP 收新邮件（IDLE+轮询）  │
  │  2. 标题命中关键词规则          │
  │  3. 附件扇出复制 → N 个路径     │
  │  4. 全部必达路径成功 → 回信     │
  │  5. 写记录 / 托盘通知          │
  └──────────────────────────────┘
        │
        ▼
D:\POD\生产\卡套\POD_ORDER_20486.zip  ✔
E:\POD\备份\卡套\POD_ORDER_20486.zip  ✔
```

## 当前进度

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| 0. 需求分析（含关键词规则 v0.2） | ✅ 完成 | [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) |
| 0. 产品说明 / 信息架构 | ✅ 完成 | [docs/PRODUCT.md](docs/PRODUCT.md) |
| 1. **设计图** | ✅ 完成 | [design/mockups](design/mockups) · [设计说明书](design/index.html) · 客户版 PDF |
| 2. 技术架构与 IMAP/SMTP 接入方案 | ✅ 完成 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 3. 可点击原型（HTML demo） | ⏳ 待客户确认设计后 | `design/prototype/` |
| 4. 应用开发（Electron + Windows 打包） | ✅ **MVP 已完成** | `src/`（19.8k 行，双端 typecheck + build 通过） |
| 5. 本地联调（模拟 IMAP/SMTP 服务器） | ✅ 完成 | `scripts/mock-mail-server.mjs`，e2e 69 断言全过 |
| 6. Windows 安装包 | ⏳ 待 Windows 机器/CI 执行 | `pnpm dist:win` |

**工期估算**：34–36 人天（含 15% 缓冲 39–41 人天）；2 人并行约 5 周，1 人约 8–9 周。其中「IMAP 收信 + 中文文件名解析 + 规则引擎 + 多路径扇出 + 部分失败恢复」单列 14–16 人天，是最大复杂点。

## 技术选型（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）

**Electron + React 18 + TypeScript**（业务逻辑全在主进程，渲染层走 `file://`，**不起本地 HTTP 服务、不监听任何端口**；收信用 IMAP 长连接、发信用 SMTP，均为出站）。
理由：设计稿是 HTML 可直接转组件零返工、Windows 安装/签名/托盘/自启/升级链路最成熟、维护者池最大。
备选 Tauri（体积/内存成硬指标时）。

**邮箱连接（v0.3 客户指定）**：**IMAP 收信 + SMTP 发信**，界面手填参数（服务商预设 + 测试连接），
Gmail 用**应用专用密码**、QQ 用**授权码**。**不走 OAuth**，因此不需要 Google Cloud 项目/应用验证，
首次配置从"几周审核风险"降为"几分钟生成应用专用密码"。密码用 Windows DPAPI 加密存储。

## 目录结构

```
mail-harbor/
├── docs/
│   ├── REQUIREMENTS.md     # 需求规格（v0.2，含关键词规则/多路径）
│   ├── PRODUCT.md          # 产品说明、用户故事、信息架构、设计决策
│   └── ARCHITECTURE.md     # 技术架构：选型/IMAP+SMTP 接入/DDL/里程碑
├── design/
│   ├── index.html          # 设计说明书（看图入口，自包含）
│   ├── tokens.css          # 设计令牌（纸与墨，三层 token）
│   ├── mockups/
│   │   ├── README.md       # 设计说明：交互、状态、实现约定
│   │   └── screens/        # 5 屏 + 组件总览 高保真设计稿（HTML 源）
│   ├── exports/            # 导出的 PNG / 设计说明书 PDF
│   └── prototype/          # 可点击原型（后续）
├── scripts/
│   ├── render.py           # 设计稿 → PNG（Chrome headless / Playwright）
│   ├── mockups_to_pdf.py   # 设计稿 → 客户版 PDF 说明书
│   └── check_mockups.py    # 设计稿自检（外链/必备状态）
├── src/                    # 应用源码（阶段 4，Electron 布局）
│   ├── main/               # 主进程：scheduler/pipeline/rule-engine/dispatcher/file-writer…
│   ├── preload/            # contextBridge 白名单
│   ├── renderer/           # React UI（复用 design/ 的 HTML 与 tokens.css）
│   └── shared/             # IPC 契约、枚举、zod schema
├── resources/              # 图标、预设规则 seed.json、回信模板
└── tests/                  # 单测 + playwright-electron e2e
```

## 核心需求速览

1. **关键词触发**：`原图+手机壳`、`原图+卡套`、`原图+浴室垫` 为预设；可新增、删除、启停，改完即时生效。
2. **多路径扇出**：一条关键词可配 1~N 个本地路径，同一附件复制到每个路径；单路径失败只重试该路径。
3. **路径暴露**：界面上可浏览、手输、一键打开，每路径显示剩余空间。
4. **自动回信**：全部必达路径成功后经 SMTP 回信，模板中/英文可编辑，防重复回信。
5. **可换邮箱**：服务商预设 + IMAP/SMTP 参数表单 + 测试连接，多账户启停，密码失效提醒。
6. **7×24 常驻**：开机自启、托盘、断网恢复补下载、失败重试、不静默丢件。

## 已完成的功能（MVP）

| 模块 | 状态 |
| --- | --- |
| 关键词规则引擎（精确/包含、RE:/FWD: 剥离、全半角归一、中文业务后缀、多规则全执行） | ✅ 29 单测 |
| 一条关键词 → N 个目标路径扇出；重名自动加 `(2)`；临时文件 + 原子改名 | ✅ |
| IMAP 收信（UID 增量、UIDVALIDITY 保护、BODYSTRUCTURE≤5 层、流式下载 + SHA256、IDLE + 降级轮询） | ✅ |
| SMTP 回信（模板变量、In-Reply-To/References、同线程只回一次、防轰炸、日上限、熔断） | ✅ |
| 失败重试（跨路径并行/单路径串行、路径不可用不消耗次数、15s→1h 退避、启动对账） | ✅ |
| 账户表单 + 5 个服务商预设 + IMAP/SMTP 分别测试连接（11 个错误码 + 中文修复指引） | ✅ |
| 托盘常驻 / 开机自启 / 单实例 / 关窗隐藏 / 休眠恢复补扫 | ✅ |
| 5 屏 React UI（概览/触发规则/邮箱账户/自动回复/下载记录） | ✅ 截图见 `design/exports/app/` |
| 本地模拟邮件服务器（无真实邮箱也能跑通全链路） | ✅ |

**验证结果**：`tsc --noEmit`（主进程 + 渲染层）通过 · `electron-vite build` 通过 · 核心 29 断言 + 后端 376 断言全过（含 mock IMAP/SMTP 端到端：双路径落盘、SMTP 回信、幂等复跑、部分路径失败只重试失败项、IDLE 自动收信）。

## 本地运行

```bash
# 1) 起模拟邮件服务器（无需真实账号）
node scripts/mock-mail-server.mjs

# 2) 另开一个终端，启动桌面端
pnpm dev

# 3) 在「邮箱账户」里添加：
#    预设：自定义 | IMAP 127.0.0.1:1143 不加密 | SMTP 127.0.0.1:2525 不加密
#    账号 demo@mailharbor.test / 密码 demo-pass → 测试连接 → 保存并启用
# 4) 在「触发规则」加一条：关键词「原图+卡套」，目标路径指向任意本地目录
# 5) 等 30 秒（或点「检查新邮件」），附件会自动落盘，SMTP 模拟收件箱里能收到回信

# 跑测试
pnpm test:core        # 规则引擎/文件名/复制 29 断言
pnpm test:backend     # repos/dispatcher/reply/scheduler/e2e 376 断言
node scripts/smoke-ui.mjs   # UI 冒烟（需 Playwright + Electron 二进制）
```

## 成本与报价

- 详细估算：[docs/COST.md](docs/COST.md)
- 一页可视化报价单：[cost/quote.html](cost/quote.html)
- 重算脚本：`python3 scripts/cost_estimate.py`（改 `cost/costs.json` 即可）

## 本地预览设计图

```bash
# 打开设计说明书
open design/index.html

# 把 HTML 设计稿重新导出 PNG
python3 scripts/render.py design/mockups/screens/ --width 1440 --height 900 --scale 2
```

---

*本仓库为内部项目，未公开。客户信息以 IM 沟通记录为准。*
