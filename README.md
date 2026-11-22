# MailHarbor · 邮件收货助手

> 给 POD（按需印刷定制）工厂用的 Windows 桌面软件：
> **自动盯 Gmail → 按邮件标题关键词（如「原图+卡套」）判断要不要存 → 把 ZIP/TIF 附件复制到该关键词对应的一个或多个本地文件夹 → 自动回信告诉客户"已收到"。**

```
客户发邮件（标题「原图+卡套」，附件 POD_ORDER_20486.zip）
        │
        ▼
  ┌──────────────────────────────┐
  │  MailHarbor（托盘常驻 / 开机自启）│
  │  1. 轮询 Gmail 新邮件          │
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
| 1. **设计图（本阶段交付）** | 🚧 收尾中 | [design/mockups](design/mockups) · [设计说明书](design/index.html) |
| 2. 技术架构与 IMAP/SMTP 接入方案 | ✅ 完成 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 3. 可点击原型（HTML demo） | ⏳ 待客户确认设计后 | `design/prototype/` |
| 4. 应用开发（Electron + Windows 打包） | ⏳ 待开始 | `src/` |

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

## 本地预览设计图

```bash
# 打开设计说明书
open design/index.html

# 把 HTML 设计稿重新导出 PNG
python3 scripts/render.py design/mockups/screens/ --width 1440 --height 900 --scale 2
```

---

*本仓库为内部项目，未公开。客户信息以 IM 沟通记录为准。*
