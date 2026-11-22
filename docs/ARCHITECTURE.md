# MailHarbor 技术架构与实施方案
> 版本 **v1.1** ｜ 2026-11-22 ｜ 依据 `REQUIREMENTS.md` v0.3、`PRODUCT.md` v0.3、客户 v0.3 澄清「邮箱用 SMTP/密码，不要 OAuth 授权」｜ 平台细节**以官方文档为准**（文末索引）。
> **v1.0 → v1.1 变更**：推翻 Gmail OAuth 2.0 方案，改为标准 **IMAP(收) + SMTP(发) + 应用专用密码/授权码**；数据模型、时序、风险、里程碑、状态枚举同步重写。**上线不再依赖 Google 验证，验证等待风险归零。**
> **阅读指引**：客户/决策读 §0、§2.2、§2.3、§7.1、§9、§10、附录 A；开发读 §1、§2、§4、§5、§6、§8、§11；设计读 §11。
## 0. 结论摘要（TL;DR）
- **选型不变**：**Electron + React 18 + TypeScript**，业务逻辑全部在主进程；渲染层本地 `file://`，**零入站端口**（不再需要 OAuth 回环）。主进程依赖：`imapflow`（IMAP/IDLE）+ `nodemailer`（MIME/SMTP）+ `better-sqlite3` + `zod`。
- **邮箱接入（v1.1 核心变化）**：客户在界面填"邮箱 + 应用专用密码/授权码 + 服务器"→ 一键测试连接 → **IMAP over SSL 收信（IDLE 近实时 + 兜底轮询）** → **SMTP over SSL/STARTTLS 回信**。不需要 Google Cloud 项目、不需要 OAuth、不需要 Google 验证。
- **上线周期**：v1.0 的"Google 验证/CASA 4–12 周"风险**直接归零**；剩下的是邮箱服务商策略（App Password/IMAP 是否开启）与 IMAP 稳定性，均可在首次配置的"测试连接"当场暴露。
- **业务核心不变**：关键词规则引擎 → 一条规则 N 个目标路径 → 按 **（邮件 × 附件 × 目标路径）** 建 `deliveries` 独立重试；**必达路径全成功才回信**，同一线程只回一次。
- **数据**：SQLite（WAL）单文件 9 张表；账号只存 IMAP/SMTP 配置与 `uid_validity + last_uid` 游标，密码用 DPAPI 加密。
- **交付**：electron-builder → NSIS 按用户安装（免管理员）；HKCU Run 自启 + 托盘 + 单实例锁；electron-updater 静默升级；代码签名 + 杀软误报申诉。
- **最大风险**：① 邮箱服务商策略（Gmail App Password 需 2FA、企业管理员可能禁用 IMAP/SMTP；**M365/Outlook 已不支持基本认证**）；② 中文附件文件名三种编码乱码；③ IMAP IDLE 断连 + 多路径扇出部分失败（§9）。
- **客户必须先给**：邮箱地址 + **已开两步验证并生成的应用专用密码/授权码**；确认企业邮箱未被管理员禁用 IMAP/SMTP；部署机可出站 993/465/587。

```
┌────────────── Electron 主进程（Node 20 / TypeScript）─────────────────┐
│ Scheduler(账户级单飞) ⇄ ImapSmtpProvider                              │
│   ├ IMAP: 持久连接 + IDLE + 兜底 UID 补扫 + 断线重连                   │
│   ├ SMTP: nodemailer 回信（In-Reply-To/References）                    │
│   └ Pipeline → RuleEngine → Dispatcher(多路径扇出/重试)                │
│      → FileWriter(临时文件+原子改名) → ReplyService(防轰炸/熔断)        │
│ 依赖：SQLite(WAL) ／ SecretStore(DPAPI) ／ 日志脱敏                     │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ IPC（contextBridge + zod 白名单，不暴露 Node）
┌──────────────▼──────── React 渲染进程（file://，sandbox）──────────────┐
│ 概览 / 触发规则 / 邮箱账户 / 自动回复 / 下载记录 / 设置                   │
└──────────────────────────────────────────────────────────────────────────┘
               │ 仅出站 TCP：IMAP 993(SSL)、SMTP 465(SSL)/587(STARTTLS)
   imap.gmail.com / smtp.gmail.com / imap.qq.com / smtp.qq.com / 自定义服务器
   零入站监听（无需公网回调、无本地 HTTP 服务）
```
## 1. 技术选型：对比、结论与备选（结论不变）
### 1.1 本项目真正起作用的约束
- 客户非技术、部署国外、只能远程支持 → 安装/升级/排障必须走成熟链路，不能让客户装运行时或配环境。
- 设计稿是 **HTML**（`design/mockups/screens/*.html`）→ 能直接复用 HTML/CSS 的方案省 30%+ UI 工时。
- 代码以后可能交给别人维护 → 人才池与可读性权重最高，避免"只有原作者能改"。
- 常驻内存 <200MB、空闲 CPU <2% → Electron 需实测压缩，也构成 Tauri 的加分项。
- 核心复杂度在**文件系统与状态机**（多路径扇出、原子写、断网恢复），UI 不是难点。
- v1.1 起不再有 OAuth 回调/浏览器跳转，IMAP 长连接与邮件解析成为主进程主要复杂度。
### 1.2 四方案对比（✅好 / ⚠可接受 / ❌差）
| 维度（权重） | (a) Electron + React/TS | (b) Python + FastAPI 本地 Web UI + 托盘 | (c) Python + PySide6/Qt | (d) Tauri + Rust |
| --- | --- | --- | --- | --- |
| 开发速度（25%） | ✅5｜HTML 稿直接转 React；`imapflow`/`nodemailer` 成熟 | ⚠4｜后端快但 UI 要重写；三套生命周期易踩坑 | ⚠3｜设计稿要整体重做，还原度低 | ⚠3｜前端可复用，Rust 侧 IMAP 生态弱 |
| 安装包体积（15%） | ⚠3｜NSIS 90–130MB（含 Chromium） | ⚠3｜PyInstaller 80–150MB（还依赖 WebView2） | ⚠3｜Qt 运行时 100–180MB | ✅5｜8–15MB |
| 内存占用（15%） | ⚠3｜150–250MB，优化后约 180MB | ⚠3｜120–200MB | ✅4｜90–150MB | ✅5｜80–130MB |
| 打包/签名/杀软（15%） | ✅5｜NSIS 一键、签名升级成熟，AV 视其为正常软件 | ❌2｜PyInstaller 单文件误报率最高 | ❌2｜同 PyInstaller，Qt 插件易漏打 | ⚠4｜NSIS/MSI 均可；WebView2 分发要处理 |
| 托盘+自启+单实例（10%） | ✅5｜官方 API 全覆盖 | ⚠3｜pystray+注册表手写，偶发图标丢失 | ✅5｜原生 | ✅4｜官方插件 |
| 后续维护门槛（20%） | ✅5｜TS/React 人最多、AI 辅助成熟、交接易 | ✅4｜Python 人多，但 Windows 桌面打包经验少 | ⚠3｜需 Qt 经验；PySide6 的 LGPL 合规要交代 | ❌2｜Rust 人才少、交接成本最高 |
| **加权总分（5 分制）** | **4.4 ✅ 推荐** | 3.3 | 3.2 | 3.7（备选） |
### 1.3 结论与理由
**推荐 Electron + React + TypeScript**（electron-vite 构建、electron-builder 打包），核心理由：

1. **设计交付零损耗**：HTML/CSS 可直接拆 React 组件，`tokens.css` 变量原样使用，四方案中唯一不返工。
2. **交付与维护成本最低**：Windows 上"安装包 + 签名 + 托盘 + 自启 + 静默升级"是 Electron 最成熟路径，正好覆盖"国外机器、非技术用户、远程支持"。
3. **可交接**：接手方只需 TS/React + Node 基础；业务逻辑集中在主进程十余个模块，规模"看得懂就能改"。
4. **内存目标可达但需实测**：单窗口 + 隐藏时后台节流 + 渲染层懒加载，目标 ~180MB；若实测 >250MB，按 1.4 切 Tauri，UI 层不动。
5. **零入站攻击面**：v1.1 后没有 OAuth 回环、没有本地 HTTP 端口；只做出站 993/465/587。

**主进程关键依赖（版本锁定）**：`imapflow`（IMAP 连接/IDLE/附件流）、`nodemailer`（MIME 构造 + SMTP 发送）、`mailparser`（可选，邮件头解码兜底）、`better-sqlite3`（DB）、`zod`（IPC 校验）、`electron-updater`（升级）。渲染层：`react`、`react-router`、`@tanstack/react-query`。
### 1.4 备选与改选触发条件
| 备选 | 何时改选 | 代价 |
| --- | --- | --- |
| **Tauri 2 + React**（同渲染层，壳换 Rust） | 体积/内存成合同硬指标；或客户 IT 拒绝 Chromium 系 | Rust 侧 IMAP/邮件解析需换生态（`async-imap`+`lettre`），约 +6–9 人天，接手门槛升高 |
| **Python + FastAPI + pywebview + pystray** | 接手方是纯 Python 团队且不接受 TS | +4–6 人天；需解决 PyInstaller 误报与三进程生命周期；IMAP 用 `imapclient`/`aioimaplib` |
| Python + PySide6（不推荐） | 仅当强制 Qt | 设计稿全部重做，Qt 打包与许可合规额外成本 |
### 1.5 关键架构决策（ADR）
| # | 决策 | 理由 |
| --- | --- | --- |
| A1 | 业务逻辑全在主进程，渲染层只做展示 | 单一可信边界；文件系统与邮箱密码不进 Web 上下文 |
| A2 | 渲染层 `file://` + `contextIsolation/sandbox`，IPC 用 zod 校验 | 零本地端口可被本机其它程序利用 |
| A3 | SQLite（better-sqlite3，WAL，同步 API）在主进程内 | 单机单写者、事务简单、崩溃可恢复、无需服务 |
| A4 | 邮箱密码用 `safeStorage`（Windows DPAPI）加密存 BLOB | 系统级、绑定当前 Windows 用户、不落明文 |
| A5 | 写盘 = 同目录临时文件 + `rename` 原子替换 | 断电/崩溃不留半截文件，扇出可安全重入 |
| A6 | 每账户一条 IMAP 长连接 + IDLE，失败降级轮询 | 近实时、实现简单，避免 Gmail API 配额与 OAuth 复杂度 |
| A7 | 四层状态全落库（message/attachment/delivery/reply） | 去重、部分失败重试、崩溃恢复都依赖它 |
| A8 | 规则以内存快照匹配，DB 变更后广播刷新 | 改关键词/路径**不重启即生效**（H11） |
## 2. 邮箱接入方案：IMAP 收信 + SMTP 回信（v1.1 重写）
### 2.1 方案转变、边界与术语澄清
| 项 | v1.0（OAuth） | v1.1（本次） |
| --- | --- | --- |
| 认证 | OAuth 2.0 + PKCE + 回环 + refresh_token | 邮箱账号 + **应用专用密码/授权码**，TLS 内 PLAIN/LOGIN |
| 前置依赖 | Google Cloud 项目 + OAuth 客户端 + 可能验证 | **无**（不需要 Google Cloud、不需要浏览器授权） |
| 上线周期 | Google 验证/CASA 4–12 周风险 | **0，无 Google 等待**（改为首次配置当场可测） |
| 收件 | Gmail API 轮询 + historyId | **IMAP over SSL + IDLE**（近实时）+ 兜底轮询 |
| 发件 | Gmail API messages.send | **SMTP over SSL/STARTTLS**（nodemailer） |
| 主要新风险 | Google 验证、7 天 token | 服务商 App Password/IMAP 策略、IMAP 断连、中文文件名（§9） |

> **术语澄清**：SMTP 只负责"发信"，不能收信。客户说的"SMTP 设置"实际是"**用邮箱账号 + 应用专用密码/授权码走标准协议**"。所以本方案收件用 **IMAP**、发件用 **SMTP**；界面上统一称「邮箱账户设置（IMAP / SMTP）」，不出现 OAuth/授权跳转字样。
### 2.2 连接参数与前提矩阵（实现按此预置）
| 邮箱 | IMAP | SMTP | 密码类型 | 前提 / 限制 |
| --- | --- | --- | --- | --- |
| Gmail 个人 | `imap.gmail.com:993` SSL | `smtp.gmail.com:465` SSL（备用 587 STARTTLS） | **应用专用密码**（16 位） | 必须开启两步验证 → [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) 生成；"不够安全的应用"已被 Google 停用；App Password 政策可能变化（R1） |
| Gmail Workspace | 同上 | 同上 | 同上 | 管理员可能禁用 IMAP 或 App Password；单账号约 15 个 IMAP 并发、有每日带宽限制（以官方为准） |
| QQ 邮箱 | `imap.qq.com:993` SSL | `smtp.qq.com:465` SSL | **授权码** | 邮箱设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码；**不是登录密码** |
| Outlook / M365 | `outlook.office365.com:993` | `smtp.office365.com:587` STARTTLS | ❌ 基本认证已停用 | **不支持**：M365 已停用 IMAP/POP 基本认证（App Password 同步失效），SMTP AUTH 基本认证也在退役中；只剩 OAuth/XOAUTH2，与客户"不要授权"冲突（[微软公告](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)）。保留"自定义服务器"入口但**不承诺** |
| 企业/自建 | 自定义 | 自定义 | 密码/授权码 | 需管理员开启 IMAP 与 SMTP AUTH，放行 993/465/587 出站 TLS |

> **建议**：第一期明确承诺 **Gmail + QQ**（+ 任意标准 IMAP 服务器）；Outlook/M365 仅作"实验性"，若客户坚持要收 Outlook 邮件，需改回 OAuth（与本次方向冲突），提前说明。
### 2.3 添加账户：表单 → testConnection → 保存
**表单字段（界面与 DB 一致）**：`服务商(gmail/qq/outlook/custom)`、`邮箱地址`、`显示名`、`IMAP 主机/端口/SSL`、`IMAP 用户名`、`密码(应用专用密码/授权码)`、`SMTP 主机/端口/加密(SSL/STARTTLS)`、`SMTP 用户名`、`发件显示名`；默认值按预设自动填充，可改。密码输入框只写不读（保存后显示"已保存"，不回显）。

`testConnection()` 必须**分别**验证收、发两条链路，任一步失败即给出错误码：

1. TCP 连通：`net.connect` 5s 超时，分别测 IMAP/SMTP 端口（区分 DNS 失败/端口不通）。
2. TLS 握手：`tls.connect` 校验证书链与主机名（不默认放行自签名；企业自建服务器可选"允许自签名"并醒目警告）。
3. IMAP 登录：`LOGIN` → `SELECT INBOX`（只读）→ 读 `UIDVALIDITY/UIDNEXT` → `LOGOUT`。
4. SMTP 登录：`EHLO` → `STARTTLS`（587）→ `AUTH LOGIN/PLAIN` → 可选"给自己发一封测试信" → `QUIT`。
5. 结果入库：成功 `accounts.status='enabled'` 并保存 `uid_validity/last_uid` 基线；失败保持 `testing` 并写 `last_error_code`，UI 直接显示"哪里错、怎么改"。

| 错误码 | 触发条件 | UI 文案 / 修复指引 |
| --- | --- | --- |
| `IMAP_AUTH_FAILED` | LOGIN 被拒，凭据错误 | 检查应用专用密码/授权码是否复制完整（Gmail 16 位、无空格） |
| `IMAP_APP_PASSWORD_REQUIRED` | Gmail 返回 `Application-specific password required` / `Web login required` | 该账号未开两步验证或未生成应用专用密码，按 §2.2 引导生成 |
| `IMAP_DISABLED` | 服务端未开启 IMAP（QQ/企业邮箱常见） | 去邮箱设置开启 IMAP 服务后重试 |
| `IMAP_UNREACHABLE` | DNS/端口/防火墙不通（ECONNREFUSED、ENOTFOUND） | 检查网络、企业代理、出站 993 端口 |
| `IMAP_TLS_ERROR` | 证书过期/主机名不匹配/自签名 | 检查系统时间；企业自建服务器可勾选"允许自签名" |
| `IMAP_TIMEOUT` | 握手或登录超时 | 弱网/服务器繁忙，重试或换网络 |
| `SMTP_AUTH_FAILED` | SMTP AUTH 被拒 | 同密码问题；确认 SMTP 服务已开启 |
| `SMTP_UNREACHABLE` | 465/587 不可达 | 放行出站 465/587；企业网常见 587 被拦 |
| `SMTP_TLS_ERROR` | STARTTLS 失败/证书问题 | 改用 465 SSL 或修复证书 |
| `SMTP_SENDER_REJECTED` | 发件地址不被允许（550/553） | From 必须等于登录账号或其别名 |
| `UNKNOWN` | 其它 | 记录服务端原始响应（脱敏后）供排查 |

> 映射技巧：`imapflow` 的 `err.authenticationFailed` 判认证；`err.responseText` 里匹配 `Application-specific password required` / `Web login required` / `IMAP access is disabled`；网络类看 `err.code`（`ENOTFOUND/ECONNREFUSED/ETIMEDOUT`）与 TLS 错误码（`CERT_HAS_EXPIRED/ERR_TLS_CERT_ALTNAME_INVALID`）。
### 2.4 收件：IMAP IDLE + 心跳 + 兜底轮询 + 重连
1. **每账户一条持久连接**（Gmail 约 15 并发/账号，单连接足够；不要为提速多开）。连接成功后 `SELECT INBOX`（**read-only**），取 `UIDVALIDITY`、`UIDNEXT`。
2. **UIDVALIDITY 校验**：与 DB 不一致 → 邮箱被重建/迁移，丢弃旧 `last_uid`，全量重扫最近 7 天（或最近 200 封），历史去重靠 Message-ID 唯一键兜底。
3. **启动/重连先补扫**：`UID FETCH <last_uid+1>:* (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (...)])`，按 UID 升序处理，处理完 `last_uid = max(uid)`。只取需要的头字段，附件在规则命中后再下载。
4. **IDLE**：进入 IDLE 等新邮件；收到 `EXISTS` 后防抖 500ms 触发补扫；**每 25 分钟重发 IDLE**（RFC 2177 要求客户端至少每 29 分钟重发，规避服务器静默超时）；每 5 分钟 `NOOP` 心跳。
5. **兜底轮询**：即使 IDLE 正常，每 10 分钟也执行一次 `UID SEARCH UID <last_uid+1>:*`（个别服务器会漏推送）；失败/不支持 IDLE 时降级为 30 秒轮询 `SEARCH`。
6. **断线重连**：`close/error` → 账户 `offline` → 退避 5s/10s/30s/1m/5m（封顶）重连；重连后回到第 2 步，**离线期间到达的邮件靠 UID 补扫补回**，不阻塞其它账户。
7. **只读原则**：一律 `BODY.PEEK[...]` 取信，不置 `\Seen`、不删除、不移动（操作员仍能在 Gmail/QQ 网页看到未读原信）。

> Gmail IMAP 官方限制（并发连接、每日下载/上传带宽）见 [Gmail 带宽限制](https://support.google.com/a/answer/1071518)；超限表现为临时断连/`NO` 响应，按退避重连并降级轮询。
### 2.5 附件下载与中文文件名（本项目最大解析坑，单列）
**获取附件元数据**：`FETCH (UID BODYSTRUCTURE ENVELOPE)` → 递归遍历 `bodyStructure`，取 `disposition=attachment` 或带 filename 的 part，记 `part id`、大小。**下载**：`download(uid, part, {uid:true})` 流式写 `tmp/<uidValidity>-<uid>-<part>.part`（`BODY.PEEK` 语义，不置已读），校验字节数 + SHA-256。Gmail 单封上限约 25MB（IMAP 传输含 base64 开销，`RFC822.SIZE` 约为原体积 1.37×）；下载用 `BODY.PEEK[part]<offset.length>` **分段流式写盘**（RFC 3501 部分取回）或 `download()` 流，超限/超时记 `ATTACHMENT_TOO_LARGE` / `DOWNLOAD_TIMEOUT`。

| 文件名形式 | 示例 | 解码处理 |
| --- | --- | --- |
| RFC 2047 encoded-word | `=?UTF-8?B?5Lit5paH5Zu-54mHLnppcA==?=` | 按 charset 解码；多段 encoded-word 之间的空白要丢弃后拼接；支持 `B/Q` 两种编码 |
| RFC 2231 | `filename*=UTF-8''%E4%B8%AD%E6%96%87.zip`；`filename*0*=...; filename*1*=...` | 百分号解码 + 分片按序拼接 + charset 取值 |
| 原始 8-bit（GBK/GB18030 直发） | bodyStructure 参数是 Buffer 或乱码字符串 | `TextDecoder('utf-8',{fatal:true})` 失败后依次尝试 `gb18030`→`big5`→`latin1`（Node 20 默认 full-ICU） |
| 兜底 | 全部失败 | `attachment-<n>.<ext>`；原名存 DB 供 UI 展示，落盘用清洗后名字 |

**统一清洗**：所有来源的文件名先 `basename` → 去 `<>:"/｜?*` 与控制字符 → 去结尾点/空格 → 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加前缀 → NFC 归一化 → UTF-16 长度 ≤180（再加 `(N)` 重名后缀）。

**类型判定（MIME + 后缀双重）**：ZIP 常见 `application/zip`、`application/x-zip-compressed`、`application/octet-stream`；TIF 常见 `image/tiff`、`image/tif`、`application/octet-stream`。规则：**后缀优先**（`.zip`/`.tif`/`.tiff`），MIME 兜底；可选校验 magic bytes（ZIP `PK\x03\x04`、TIFF `II*\0`/`MM\0*`）防伪装。**不解压、不预览、不执行**（规避 zip-slip/炸弹/宏病毒）。
### 2.6 SMTP 回信（nodemailer）
- 每账户一个 transport：`host/port/secure(465=true)/auth/tls.rejectUnauthorized=true`；587 用 `requireTLS`。**不池化**（单机低频率，避免连接被服务商风控）。
- `From` = 账号邮箱（Gmail/QQ 强制发件人=登录账号或已验证别名，否则 550/553），显示名 = `smtp_from_name`；`To` = 原邮件 From 地址（从 envelope 解析，**只回发件人**）；不设 Cc/Bcc/Reply-To。
- 关联原邮件：`In-Reply-To: <原 Message-ID>`、`References: <原 References...> <原 Message-ID>`、`Subject: Re: <原主题>`（已以 `Re:` 开头不重复；中文按 RFC 2047 编码；主题 CR/LF 清洗防头注入）。IMAP 无 threadId，**线程键 `thread_key` = References 第一项（根）或原 Message-ID**。
- 正文：纯文本 UTF-8（base64 传输编码），无 HTML、无外链图片；模板变量 `{文件名}{数量}{关键词}{时间}`。
- 限额与限速：Gmail 免费约 500 收件人/天、Workspace 约 2000（以[官方发信限额](https://support.google.com/mail/answer/22839)为准），单封 ≤100 收件人；发送速率 ≤1 封/2s；`421/450/451` 退避重试，`550/553` 永久失败不重试。
- **防垃圾邮件**：用客户自己的账号发（SPF/DKIM 天然通过）、纯文本、正常主题、低频、不伪造发件人；记录退信并暂缓该账户发送。
- **防轰炸**（保留）：同线程只回一次（`auto_replies.thread_key` 唯一）；所有必达 delivery 成功才发；跳过自动回复（`Auto-Submitted`）、`mailer-daemon`/`no-reply`、发件人=自己；日上限默认 300；连续 3 次失败熔断 30 分钟。
### 2.7 去重、游标与断点续传
| 粒度 | 唯一键 | 作用 |
| --- | --- | --- |
| 邮件 | `messages(account_id, provider_message_id)`；`provider_message_id` = 原 `Message-ID`，缺失时用 `uid:<uidvalidity>:<uid>` | 同一封只处理一次（UIDVALIDITY 变化后仍不重复） |
| 附件 | `attachments(message_id, part_id)` | 不重复下载/哈希 |
| 投递 | `deliveries(attachment_id, target_id)` | **路径 A 成功、B 失败时只重试 B**，A 永不重写 |
| 回信 | `auto_replies(account_id, thread_key) WHERE status='sent'` | 同线程只回一封 |
| 游标 | `accounts.uid_validity + last_uid` | 断线/重启后从 UID 补扫 |
| 兜底 | `messages.received_at` + 兜底重扫窗口 | 防 IDLE 丢事件、防 UID 异常 |

- **启动对账**：扫 `deliveries` 中 `pending/copying/retry_wait` 重新入队；`copying` 的先查目标文件 size+SHA-256 是否与期望一致——一致直接 `done`（幂等），否则重做；清理 tmp 中 >24h 的 `.part`；`messages.status='queued'` 重跑流水线。
- **写盘顺序**：登记 `delivery(state=copying, intended_name)` → 写临时文件 → `rename` 到目标名 → 更新 `done(saved_path,size,sha256)`；rename 后崩溃也能凭 size+sha 认领文件。重名：已存在则 `name (2).ext`、`(3)`…，不覆盖。
## 3. MailProvider 抽象（统一 IMAP/SMTP，QQ 不再单列二期）
### 3.1 接口
```ts
interface MailProvider {
  testConnection(): Promise<TestResult>;           // 必须：分别验证 IMAP + SMTP，返回错误码
  connect(): Promise<void>;
  startIdle(onNewMail: () => void): Promise<void>; // 进入 IDLE；不支持则内部降级轮询
  fetchNewMessages(): Promise<MessageRef[]>;       // 按 last_uid 补扫
  fetchMessage(ref: MessageRef): Promise<InboundMessage>;
  downloadAttachment(ref: MessageRef, part: AttachmentRef, sink: Writable): Promise<DownloadResult>;
  sendReply(req: ReplyRequest): Promise<{ providerMessageId: string }>;
  healthCheck(): Promise<HealthResult>;
  disconnect(): Promise<void>;
}
```
- 实现：`ImapSmtpProvider` 一个实现 + `presets.ts` 预设（Gmail/QQ/自定义/Outlook 标记不支持）；**QQ 不再需要二期**，加账户即选预设。
- `InboundMessage`：`uid / rfcMessageId / references / subject / from / receivedAt / parts[]`；`AttachmentRef`：`partId / filename(已解码) / mimeType / size`。
- 若未来某客户坚持 OAuth（如 M365），新增 `Xoauth2Provider` 实现同一接口即可，其余模块零改动；但本期按客户要求不实现。
### 3.2 预设参数表（UI 下拉直接复用）
| 预设 | IMAP | SMTP | 密码类型 | 支持度 |
| --- | --- | --- | --- | --- |
| Gmail | imap.gmail.com:993 SSL | smtp.gmail.com:465 SSL | 应用专用密码（需 2FA） | ✅ 支持（受 Google 政策影响，R1/R2） |
| QQ 邮箱 | imap.qq.com:993 SSL | smtp.qq.com:465 SSL | 授权码 | ✅ 支持 |
| Outlook/M365 | outlook.office365.com:993 | smtp.office365.com:587 STARTTLS | 基本认证已停用 | ❌ 不支持（仅保留入口，提示不可用） |
| 自定义 IMAP | 用户填 | 用户填 | 密码/授权码 | ✅ 支持（需管理员开放） |
## 4. 数据模型（SQLite DDL）
> 时间统一 UTC 毫秒（INTEGER）；布尔 0/1；JSON 存 TEXT；密码字段由 `safeStorage` 加密后写 BLOB，**数据库与导出配置均无明文**。迁移脚本放 `src/main/db/migrations/NNN_*.sql`，启动按 `schema_meta.version` 顺序执行。

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE accounts (                      -- 全部走 IMAP+SMTP；provider 只标识服务商预设（协议一致）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'custom' CHECK(provider IN ('gmail','qq','outlook','custom')),
  email TEXT NOT NULL, display_name TEXT,
  status TEXT NOT NULL DEFAULT 'testing'
         CHECK(status IN ('enabled','disabled','auth_failed','offline','testing')),
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL DEFAULT 993, imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT NOT NULL, imap_pass_enc BLOB NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL DEFAULT 465, smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_user TEXT NOT NULL, smtp_pass_enc BLOB NOT NULL,
  smtp_from_name TEXT,                        -- 回信显示名，如 "MailHarbor 收货助手"
  uid_validity INTEGER, last_uid INTEGER,     -- IMAP 游标；UIDVALIDITY 变化则全量重扫
  last_sync_at INTEGER, last_ok_at INTEGER, last_error_code TEXT, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(email, imap_host)
);

CREATE TABLE rules (                         -- 软删除：deleted_at 置位后不再匹配，历史仍可引用
  id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'subject' CHECK(scope IN ('subject','subject_body')),
  mode TEXT NOT NULL DEFAULT 'exact' CHECK(mode IN ('exact','contains')),
  priority INTEGER NOT NULL DEFAULT 100,     -- 数字越小优先级越高
  file_types TEXT NOT NULL DEFAULT '["zip","tif","tiff"]', auto_reply INTEGER NOT NULL DEFAULT 1,
  hit_messages INTEGER NOT NULL DEFAULT 0, hit_files INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER,
  deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE rule_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                        -- 绝对路径或 UNC；存原始输入，写入时归一化
  required INTEGER NOT NULL DEFAULT 1,       -- 1=必达（失败阻塞回信并重试） 0=尽力而为
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER, created_at INTEGER NOT NULL, UNIQUE(rule_id, path)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id),
  provider_message_id TEXT NOT NULL,         -- 原 Message-ID；缺失用 uid:<uidvalidity>:<uid>
  imap_uid INTEGER, thread_key TEXT, rfc_message_id TEXT,
  subject TEXT, from_addr TEXT, from_name TEXT, received_at INTEGER,
  matched_rule_id INTEGER REFERENCES rules(id), matched_keyword TEXT,  -- 关键词快照
  match_source TEXT CHECK(match_source IN ('subject','body','none')),
  status TEXT NOT NULL DEFAULT 'queued'
         CHECK(status IN ('ignored_no_keyword','ignored_type','queued','partial','done','failed')),
  auto_reply_status TEXT NOT NULL DEFAULT 'pending'
         CHECK(auto_reply_status IN ('disabled','pending','suppressed','sent','failed')),
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(account_id, provider_message_id)
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,                     -- IMAP BODYSTRUCTURE 的 part 编号，如 "1.2"
  filename TEXT NOT NULL,                    -- 已解码的原始文件名（UI 展示用）
  filename_raw TEXT, mime_type TEXT, declared_size INTEGER,
  tmp_path TEXT, sha256 TEXT,                -- 本地 .part 缓存，供多路径扇出复用
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK(status IN ('pending','downloaded','failed','skipped')),
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(message_id, part_id)
);

CREATE TABLE deliveries (                    -- 核心：附件 × 目标路径，一条对应一次落盘，独立重试
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES rule_targets(id),
  target_path TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,   -- 快照
  state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','copying','done','retry_wait','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
  saved_path TEXT, saved_name TEXT, size INTEGER, sha256 TEXT,
  error_code TEXT, error TEXT,               -- PATH_UNAVAILABLE/NO_SPACE/ACCESS_DENIED/SHA_MISMATCH…
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(attachment_id, target_id)
);

CREATE TABLE auto_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id),
  message_id INTEGER NOT NULL REFERENCES messages(id), thread_key TEXT NOT NULL,
  to_addr TEXT NOT NULL, subject TEXT, body_preview TEXT,
  status TEXT NOT NULL CHECK(status IN ('sent','failed','suppressed')),
  provider_message_id TEXT, error TEXT, attempted_at INTEGER, sent_at INTEGER
);
CREATE UNIQUE INDEX ux_reply_thread_sent ON auto_replies(account_id, thread_key) WHERE status='sent';

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
  scope TEXT, message TEXT NOT NULL, detail TEXT, redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_msgs_time ON messages(received_at DESC);
CREATE INDEX ix_msgs_status ON messages(status);
CREATE INDEX ix_dlv_queue ON deliveries(state, next_retry_at);
CREATE INDEX ix_dlv_msg ON deliveries(message_id);
CREATE INDEX ix_targets_rule ON rule_targets(rule_id);
CREATE INDEX ix_logs_ts ON logs(ts);
```
- `settings` 常用键：`poll.intervalSec`（30，兜底轮询）、`idle.renewMin`（25）、`idle.heartbeatSec`（300）、`match.multiRuleStrategy`（`all`|`priority`）、`retry.maxAttempts`（8）、`reply.enabled/delaySec/dailyCap`、`autostart`、`log.level`、`storage.defaultPath`（兜底路径，默认关闭）。
- `accounts.status` 五态：`enabled`（监听中）/`disabled`（用户停用）/`auth_failed`（认证失败，需重填密码）/`offline`（网络或连接异常，自动重连）/`testing`（刚创建未通过测试）。
## 5. 模块划分与目录结构
```
mail-harbor/
├─ package.json / electron.vite.config.ts / electron-builder.yml / tsconfig.json
├─ resources/                 # icon.ico, tray.png, 预设规则 seed.json, 回信模板, 离线字体子集
├─ scripts/                   # sign.ps1, release.ps1（构建+签名+上传）, seed-demo.ts
├─ tests/                     # unit(规则/文件名解码/扇出/对账) + e2e(playwright-electron)
└─ src/
   ├─ main/                   # ★ Electron 主进程：全部业务逻辑
   │  ├─ index.ts             # 入口：单实例锁、安全开关、崩溃兜底、优雅退出
   │  ├─ window.ts / tray.ts / autostart.ts  # 窗口(懒创建/关闭即隐藏)、托盘菜单与通知、开机自启+--autostart
   │  ├─ ipc/                 # 按域拆（accounts/rules/records/settings/ops），zod 校验入参
   │  ├─ core/
   │  │  ├─ scheduler.ts      # 账户级单飞：IDLE 事件→处理，兜底轮询，重连退避
   │  │  ├─ pipeline.ts       # 单封邮件状态机：fetch→match→download→fanout→reply→aggregate
   │  │  ├─ rule-engine.ts    # 归一化+exact/contains+多规则策略+类型白名单；内存快照热更新
   │  │  ├─ dispatcher.ts     # deliveries 调度：单路径串行/跨路径并行、重试队列、reconcile
   │  │  ├─ file-writer.ts    # 路径校验清洗、重名(2)、临时文件+原子改名、空间检查、long-path
   │  │  ├─ reply-service.ts  # 模板渲染、MIME 构造、防轰炸、日上限、熔断
   │  │  ├─ recovery.ts       # 启动对账、.part 清理、状态修复
   │  │  └─ health.ts         # 账户健康、磁盘空间、在线/唤醒事件、告警聚合
   │  ├─ providers/imap/      # ★ 唯一 Provider：IMAP 收 + SMTP 发
   │  │  ├─ connection.ts     # imapflow 连接/重连/只读 SELECT/UID 补扫
   │  │  ├─ idle.ts           # IDLE 进入/重发(25min)/心跳/EXISTS 防抖/降级轮询
   │  │  ├─ fetch.ts          # BODYSTRUCTURE 遍历、附件流式下载、大小/超时校验
   │  │  ├─ filename.ts       # 中文文件名三种编码解码链 + 安全清洗（§2.5）
   │  │  ├─ smtp.ts           # nodemailer transport、MIME、错误码映射
   │  │  ├─ presets.ts        # Gmail/QQ/Outlook/自定义默认参数与限制
   │  │  └─ provider.ts       # MailProvider 实现（含 testConnection）
   │  ├─ db/                  # index.ts(打开/迁移/事务) migrations/ repos/(accounts|rules|messages|attachments|deliveries|replies|settings|logs)
   │  ├─ security/            # secret-store.ts(safeStorage) sanitize.ts(文件名/路径穿越/日志脱敏) validate-path.ts
   │  └─ settings/ + log/     # 默认值与热更新广播；文件日志按天轮转（脱敏后落盘+落库）
   ├─ preload/index.ts        # contextBridge 白名单 API（不暴露 Node 对象）
   ├─ shared/                 # ipc-contract.ts、enums.ts、zod schema、常量（主/渲染共享）
   └─ renderer/               # React UI（设计稿 HTML → 组件 + tokens.css 变量）
      ├─ index.html / main.tsx / app/（路由、布局、错误边界）
      ├─ pages/{Dashboard,Rules,Accounts,AutoReply,Records,Settings}
      ├─ components/（Table/StatusDot/DeliveryBadges/PathPicker/PasswordField/EmptyState）
      └─ lib/（ipc 封装、React Query 缓存、格式化）
```
职责边界：**渲染层不碰文件系统、不碰邮箱密码、不直连 IMAP/SMTP**；主进程是唯一可信域。UI 通过 `window.mailharbor.*` 白名单方法读写，状态更新靠主进程推送事件（§11.3）。
## 6. 关键流程时序
### 6.1 添加邮箱：填表 → 测试连接 → 保存并监听
```
用户                 主进程(TS)                           邮箱服务器
 │ 选服务商/填服务器  │                                      │
 │ 邮箱+应用专用密码  │                                      │
 │ 点【测试连接】     │                                      │
 │───────────────────>│ TCP 993/465/587（5s 超时）            │
 │                   │─────────────────────────────────────>│
 │                   │ IMAP LOGIN → SELECT INBOX（只读）      │
 │                   │─────────────────────────────────────>│
 │                   │<── OK / UIDVALIDITY / UIDNEXT ────────│
 │                   │ SMTP EHLO → STARTTLS → AUTH LOGIN      │
 │                   │─────────────────────────────────────>│
 │                   │<── 235 认证成功 / 错误码 ──────────────│
 │                   │ 成功: 加密存密码, status=enabled, IDLE  │
 │<── 绿点"已连接" ───│                                      │
 │                   │ 失败: 返回错误码(§2.3)，状态不变        │
 │<── 红字提示+修复引导                                      │
```
### 6.2 IDLE 收到新邮件 → 规则匹配 → 下载 → 多路径扇出 → SMTP 回信 → 记录
```
IMAP IDLE 收到 EXISTS（或兜底轮询命中）
 ▼
UID FETCH last_uid+1:* (UID + 头字段) → 按 UID 升序处理，更新 last_uid
 ▼
去重: messages 唯一键已存在且状态非 queued → 跳过
 ▼
FETCH BODYSTRUCTURE + 正文 → 标题/正文归一化 → RuleEngine.match()
 ├─ 未命中任何启用规则 → status=ignored_no_keyword（默认留痕，可配置为不记录）
 ├─ 命中多条 → settings.match.multiRuleStrategy: 全部执行 / 仅最高优先级
 ├─ 命中但附件类型全不在白名单 → status=ignored_type
 ▼
BODY.PEEK[part] 流式下载 → tmp/<uidValidity>-<uid>-<part>.part（校验 size+SHA-256）
 ▼
为每个命中规则的每个启用 target 生成 delivery（INSERT OR IGNORE，幂等）
 ▼
Dispatcher：跨路径并行、单路径串行（全局并发 4）
  copy tmp → <target>/.mh-<uuid>.part → 校验 size/SHA → rename 为最终名
  → delivery=done(saved_path,size,sha256) / retry_wait
 ▼
判定：所有 required delivery=done 且规则 auto_reply=1
 → ReplyService.sendOnce()（thread_key 唯一）→ SMTP 发送 → auto_reply_status=sent
 ▼
聚合：全 done→messages.status=done；有 required 未完成→partial
   → 记录页刷新 + 托盘通知 + rules.hit_messages/hit_files+1
```
### 6.3 多路径部分失败与重试（本项目最复杂流程）
```
Dispatcher 每 3s 扫：deliveries WHERE state IN ('pending','retry_wait') AND next_retry_at<=now
 ├─ 前置检查：路径存在? 可写? 剩余空间 ≥ 附件×1.2?
 │    ├─ 否 → state=retry_wait, error_code=PATH_UNAVAILABLE/NO_SPACE
 │    │        ★ 不消耗 attempts，60s 后再查；UI 该路径标红、概览橙点，持续告警
 │    └─ 是 → 写临时文件 + 原子 rename
 ├─ 成功 → state=done + saved_path/size/sha256
 └─ 失败 → attempts+1；退避 15s→30s→1m→2m→5m→10m→30m→1h
           attempts > maxAttempts(默认8) → state=failed（记录页可手动重试）
 ★ 已 done 的 delivery 永不重做：A 盘成功、B 盘失败 → 只重试 B，A 不重复写
 ★ 回信等待所有 required done；optional 失败只告警，不阻塞回信
```
### 6.4 断线 / 休眠恢复（IDLE 重连 + UID 补扫）
```
imapflow 'close'/'error'、net 'offline'、powerMonitor 'suspend'
 → 账户 status=offline（黄灯，不弹窗），停止 IDLE，指数退避重连 5s→…→5m
net 'online' / 'resume' / 重连成功
 → 立即恢复流程（不等下个周期）：
   1) 重新 SELECT INBOX（只读），读 UIDVALIDITY
      ├─ 与 DB 相同 → UID FETCH last_uid+1:* 补扫（离线期间的新邮件全部补回）
      └─ 变了 → 丢弃 last_uid，全量重扫最近 7 天/200 封（Message-ID 去重）
   2) 重新入队未完成的 deliveries，恢复扇出
   3) 重新进入 IDLE
 目标：恢复后 30 秒内跑完一轮（NFR）；重复结果由唯一键去重
```
### 6.5 密码失效 / 认证失败 → 重新填写
```
IMAP/SMTP 返回认证错误（用户改密码、撤销应用专用密码、管理员关 IMAP、服务商策略变化）
 → 账户 status=auth_failed，停止 IDLE 与回信（其它账户照常）
 → 概览横幅 + 托盘提示"邮箱需要重新设置密码"；不弹模态框打断
用户点【重新设置】→ 打开账户编辑（密码不回显）→ 重填 → 【测试连接】
 → 成功：status=enabled，重新 SELECT/IDLE，补扫 last_uid+1:*
 → 失败：保持 auth_failed，展示错误码与修复指引；后台最多每 30 分钟重试一次连接
```
## 7. Windows 交付
### 7.1 打包、自启、托盘、单实例、升级
| 项 | 方案 | 关键点 |
| --- | --- | --- |
| 安装包 | electron-builder → **NSIS**，**按用户安装**（`%LOCALAPPDATA%\Programs\MailHarbor`） | 免管理员/UAC，避开企业策略；带卸载器 |
| 开机自启 | `app.setLoginItemSettings({openAtLogin:true, args:['--autostart']})`（HKCU Run） | `--autostart` 时不显示窗口只进托盘；Run 键在登录后触发，需客户机**自动登录**；备选：启动文件夹快捷方式 / 计划任务"登录时"（可延迟 30s），设置页可切换 |
| 托盘 | 原生 `Tray` + 菜单（打开主界面/暂停监听/今日概览/打开存储目录/退出） | 关闭窗口=隐藏；`app.setAppUserModelId('com.mailharbor.app')` 否则 Win10 通知不显示 |
| 单实例 | `app.requestSingleInstanceLock()`；第二实例触发 `second-instance` 聚焦主窗后退出 | 防重复 IMAP 连接/重复回信 |
| 升级 | `electron-updater` + NSIS + blockmap 差量；每日检查、后台下载 | 更新包必须签名；退出时安装；托盘提示"已就绪，重启更新" |
| 卸载 | 保留用户数据（DB/日志/密码），仅删程序 | 换机："导出配置（不含密码）→ 新机重填应用专用密码" |
| 网络诊断 | 设置页/向导内置：DNS、TCP 993/465/587、TLS 证书、IMAP/SMTP 登录逐项检测 | 对应 §2.3 错误码；国外机器优先排查端口封锁与代理 |
### 7.2 代码签名与杀软误报缓解
- 证书：**OV 或 EV 代码签名证书**（EV 可快速积累 SmartScreen 信誉）；预算允许可用 Azure Trusted Signing（需企业资质验证）。签名对象：主程序 exe、安装包、卸载器，**全部带 RFC3161 时间戳**。
- 首发前把安装包提交 [Microsoft WDSI](https://www.microsoft.com/en-us/wdsi/filesubmission) 申报误报，同步提交主流 AV 厂商；**避免**自解压壳、UPX 类加壳、installer 内动态释放可执行文件。
- 签名证书/密码只放 CI Secret；产物与发布清单归档（便于申诉）。
### 7.3 路径相关的坑（必须写进代码规范）
| 坑 | 处理 |
| --- | --- |
| 中文/空格/emoji 路径 | Node 全程 UTF-8；**禁止**拼 `cmd.exe` 命令行，统一 `fs`/`spawn(args)`；CSV 用 UTF-8 BOM 便于 Excel 打开 |
| 长路径 >260 | 归一化为绝对路径后加 `\\?\` 前缀再写盘；同时读 `LongPathsEnabled` 告警（[微软文档](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation)） |
| OneDrive 重定向 | 用户目录/桌面可能被 OneDrive 接管；目标在其下 → 设置页警告"会同步上云 + 可能被占位符替换"；检测重解析点拒绝写入 |
| 网络盘/UNC | 优先存 `\\server\share\...` 而非盘符（登录后盘符可能未映射）；断连按 `PATH_UNAVAILABLE` 降级，不阻塞其它路径 |
| 磁盘满 | 写入前 `fs.statfs` 预检（剩余 < 1.2×附件大小 → `NO_SPACE`）；概览/规则页展示每个目标盘剩余空间（H13） |
| 杀软锁文件 | 写 `.part` 后 rename 可能遇 `EPERM/EBUSY`：退避重试 3 次（1s/3s/5s），仍失败记 `ACCESS_DENIED` |
| 文件名非法 | 过滤 `<>:"/｜?*`、控制字符、结尾点/空格、保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）；UTF-16 长度 ≤180 后再加 `(N)` |
| 时区/语言 | DB 存 UTC 毫秒，UI 按本机时区显示；内置字体子集（不依赖系统字体）；界面全中文 |
| 电源设置 | 部署清单要求关闭睡眠/休眠；软件侧 `powerMonitor` resume 立即补扫（仍需客户配合） |
## 8. 安全与隐私
| 面 | 措施 |
| --- | --- |
| 邮箱密码 | `safeStorage`（DPAPI，绑定当前 Windows 用户）加密存 BLOB；**永不落明文、不进日志、不随配置导出**；换机/换用户不可解密 → 提示重新填写（可接受且不泄露） |
| 传输安全 | IMAP/SMTP 强制 TLS（993/465 SSL，587 STARTTLS + `requireTLS`），默认校验证书链与主机名；"允许自签名"仅对企业自建服务器开放且需二次确认 |
| 日志脱敏 | 统一 `redact()`：密码、授权码、SMTP 认证串全掩码；发件人邮箱在日志导出时打码（DB 内保留供记录页）；服务端原始错误截断后入库 |
| 本地攻击面 | 渲染层 `file://`，**零本地监听端口**；无公网回调、无 Web 服务；IPC 白名单 + zod 校验 + 校验 `senderFrame` 为自家页面 |
| Electron 加固 | `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`webSecurity:true`；禁 `will-navigate`/新窗口；CSP 禁外链 |
| 邮件头注入 | 回信的 Subject/To/显示名来自不可信邮件头 → 剔除 CR/LF 与非法字符后再交给 nodemailer，防 SMTP 头注入 |
| 路径穿越 | 附件名来自陌生邮件 → `basename` + 非法字符清洗 + 拒绝 `..`；落盘前 `path.resolve(target,name)` 必须仍在 target 内；**不解压** |
| 图稿不外传 | 附件只在本机落盘、不上传；不做内容分析/OCR；崩溃上报默认关闭；更新检查只发版本号 |
| 更新/供应链 | 只从 HTTPS 更新源下载；`electron-updater` 校验 SHA-512 + 签名发布者；锁版本 + lockfile；生产包不装 devDependencies |
| 最小权限 | 按用户安装、无管理员、无系统服务、仅写 HKCU Run；邮件只读（`BODY.PEEK`，不标记已读/不删除） |
## 9. 技术风险清单（v1.1 重写）
| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | Gmail App Password 政策变化（Google 逐步弱化"密码类"登录），或入口/文档变动 | 中 | 高 | 预设+错误码封装，UI 给最新操作指引；上线前实机验证；保留"改用 Workspace/其他邮箱"的运营话术 |
| R2 | Gmail 未开两步验证 / 高级保护计划 / Workspace 管理员策略 → 无法生成应用专用密码 | 中 | 高 | 向导第一步检测并引导开 2FA；测试连接返回 `IMAP_APP_PASSWORD_REQUIRED`；提前让客户完成附录 A2 |
| R3 | 企业邮箱/Workspace 管理员禁用 IMAP 或 SMTP AUTH（993/465/587 被策略关闭） | 中 | 高 | 测试连接当场暴露；要求客户先找 IT 开权限；给管理员操作清单（附录 A4） |
| R4 | **Outlook/M365 不支持**：IMAP/POP 基本认证已停用（SMTP AUTH 亦在退役），App Password 同步失效 | **高** | **高**（若客户误以为能收 Outlook） | 预设显式标注"不支持"；客户若确有 Outlook 邮箱需回到 OAuth（与本期方向冲突），提前书面告知 |
| R5 | IMAP IDLE 断连/服务器静默超时/丢 EXISTS 事件 | 高 | 中 | 25 分钟重发 IDLE + 5 分钟 NOOP + 10 分钟兜底 SEARCH；断线指数退避重连；重连必做 UID 补扫 |
| R6 | 中文附件文件名乱码（RFC 2047 / RFC 2231 / GBK 原始字节三种来源） | 高 | 中（文件名错可感知） | §2.5 解码链 + 单测覆盖三种编码；解码失败用 `attachment-<n>` 兜底；原名存 DB 供 UI 显示 |
| R7 | 大附件（约 25MB）通过 IMAP 传输超时/带宽限制/服务端拒绝 | 中 | 中 | 先读 `RFC822.SIZE` 预判；180s 超时 + 1 次重试；超限记 `ATTACHMENT_TOO_LARGE` 提示发件人改链接/分卷 |
| R8 | 回信被判垃圾邮件/退信（QQ/企业邮箱风控、频率过高） | 中 | 中 | 纯文本、正常主题、客户自己账号发（SPF/DKIM 天然通过）、≤1 封/2s、日上限 300、退信告警并暂停该账户 |
| R9 | IMAP 服务商限制（Gmail 约 15 并发/账号、每日带宽）导致长连接被断 | 中 | 中 | 每账户仅 1 条连接、只取必要头字段、附件按需下载；断连退避重连；异常降级轮询 |
| R10 | 多路径扇出部分失败/重复写（A 成功 B 失败、崩溃后重做） | 中 | 高（垃圾文件/漏件） | 四层唯一键 + delivery 状态机 + 临时文件原子改名 + 启动对账；专项测试断盘/断电/同名/UNC |
| R11 | 部署机休眠/关机漏件 | 中 | 中 | 客户电源策略（禁睡眠）+ 开机自启 + resume 立即补扫 + UID 补扫兜底 |
| R12 | 网络封锁 `993/465/587` 或代理拦截 | 中 | 高 | 部署前网络诊断逐项检测；支持系统代理；提示客户 IT 放行出站 TLS 端口 |
| R13 | 杀软误报/隔离主程序 | 中 | 高 | 代码签名 + 提交误报 + 不加壳；安装目录加入白名单（客户 IT 执行） |
| R14 | 用户改密码/撤销应用专用密码/管理员关闭 IMAP → `auth_failed` | 中 | 中 | 状态灯 + 托盘提示 + 一键重设；不丢已下载记录，恢复后 UID 补扫 |
| R15 | 崩溃后重复回信/重复落盘 | 低 | 高 | 状态机 + 唯一索引 + 对账；发送先记 `sending` 再确认 `sent`（两阶段） |
## 10. MVP 里程碑与工时估算（v1.1 下调）
单位：人天（含自测，不含客户等待）；按 2 人（1 主程 + 1 前端/测试）并行估算。与 v1.0 相比：OAuth/回环/token 工作约 -4 人天，新增 IMAP 解析、中文文件名、连接诊断约 +4～5 人天，净略降。

| 里程碑 | 内容 | 人天 | 依赖/风险 |
| --- | --- | --- | --- |
| **M1 骨架 + 账户与连接** | Electron 工程/构建/单实例/DB 迁移；账户表单 + 预设；`testConnection`（IMAP/SMTP/TLS/端口，11 个错误码）；DPAPI 密码存储；账户 CRUD/健康检查/网络诊断 | 5 | 需客户先拿到应用专用密码；**R2/R3/R4 在此暴露** |
| **M2 IMAP 收信 + 规则 + 多路径扇出 + 部分失败恢复（最大复杂点）** | IDLE/心跳/兜底轮询/断线重连/UIDVALIDITY；BODYSTRUCTURE 解析 + 中文文件名解码链 + 流式下载；规则引擎（归一化/exact 或 contains/多规则策略/白名单/热更新）；deliveries 状态机与重试；启动对账与崩溃恢复 | **14–16** | 依赖 M1；**工期与质量核心**，独立排期 + 专项测试（三种文件名编码/断盘/断电/同名/长路径/UNC） |
| **M3 SMTP 回信 + 记录 + 告警** | 模板渲染/预览/测试信；MIME + In-Reply-To/References + thread_key；防轰炸/日上限/熔断；退信与发送错误处理；记录页多路径结果、筛选、重试、CSV；托盘通知/告警 | 5 | 依赖 M2 的聚合状态 |
| **M4 托盘 + 自启 + 打包 + 签名 + 升级** | 托盘菜单/隐藏启动；HKCU Run 自启；NSIS 安装/卸载；代码签名；electron-updater；干净 Win10/Win11 安装冒烟 | 5 | 签名证书需提前采购 |
| **M5 测试 + 现场部署 + 交接** | 端到端验收（REQUIREMENTS §8 全部条目）；真机部署（含 Gmail/QQ 各一遍）；用户/运维/交接文档；误报申诉 | 5 | 需客户配合机器、邮箱与远程 |
| **合计** | | **34–36**（含 15% 缓冲 → **39–41**） | 2 人约 **5 周**；1 人约 **8–9 周** |

关键路径：**M2（IMAP 解析+中文文件名+扇出）与客户侧邮箱准备并行**。M2 的 14–16 人天不要压缩；邮箱账号/应用专用密码、管理员开放 IMAP/SMTP 需在 M1 前拿到，否则 M1/M5 都要等。
## 11. 给设计的接口 / 状态约定
### 11.1 枚举（文案与颜色 token 直接照此实现；token 名以 `design/tokens.css` 为准）
**账户状态 `AccountStatus`**

| 值 | 文案 | 颜色 token | 说明 |
| --- | --- | --- | --- |
| `enabled` | 监听中 | `--color-success` | 连接正常、IDLE 或轮询运行中 |
| `testing` | 待测试 | `--color-info` | 刚添加/改配置未通过测试连接 |
| `disabled` | 已停用 | `--color-text-tertiary` | 用户手动停用，不连接 |
| `auth_failed` | 认证失败 | `--color-danger` | 密码变更/撤销/未开 IMAP，横幅 + 【重新设置密码】 |
| `offline` | 连接中断 | `--color-warning` | 网络或 IMAP 断连，自动重连，不打扰 |

**邮件聚合状态 `MessageStatus`**（与 REQUIREMENTS v0.2 一致）

| 值 | 文案 | 颜色 | 说明 |
| --- | --- | --- | --- |
| `ignored_no_keyword` | 未命中关键词 | `--color-text-tertiary` | 默认留痕可筛（是否记录可配置） |
| `ignored_type` | 附件类型不符 | `--color-text-tertiary` | 命中规则但附件不在白名单 |
| `queued` | 处理中 | `--color-info` | 下载/扇出进行中 |
| `partial` | 部分成功·待重试 | `--color-warning` | 至少一个 required delivery 未完成 |
| `done` | 已完成 | `--color-success` | 全部 required 成功（optional 失败不改变） |
| `failed` | 失败 | `--color-danger` | 重试耗尽，需人工介入 |

**投递状态 `DeliveryState`**（记录页每条路径一个徽标：✔ 成功 / ✖ 失败 / ⏳ 等待 / ⚠ 重试中 / – 跳过）

| 值 | 文案 | 徽标 | 颜色 |
| --- | --- | --- | --- |
| `pending` | 排队中 | ⏳ | `--color-text-tertiary` |
| `copying` | 复制中 | ⏳ | `--color-info` |
| `done` | 已写入 | ✔ | `--color-success` |
| `retry_wait` | 等待重试（路径不可用/空间不足） | ⚠ + 倒计时 | `--color-warning` |
| `failed` | 重试失败 | ✖ | `--color-danger` |
| `skipped` | 已跳过（规则/路径被删或停用） | – | `--color-text-tertiary` |

**回信状态 `ReplyStatus`**：`disabled`（规则/总开关关闭）· `pending`（等待必达路径完成）· `suppressed`（同线程已回过/命中防轰炸）· `sent` · `failed`。文案：已回信 / 等待中 / 已抑制（同线程）/ 回信失败。
**路径可用性 `TargetHealth`**：`ok`（✔ 正常 · 剩余 xx GB）· `low_space`（⚠ 低空间，<2GB）· `unavailable`（✖ 不可用：盘不存在/无权限）· `unknown`（未检测）。规则页每条路径 chip 展示。
**连接测试结果 `TestResult`**：`ok` · `IMAP_*` / `SMTP_*` / `UNKNOWN`（错误码表见 §2.3，UI 直接显示错误码对应的"修复指引"文案）。
### 11.2 页面所需字段（IPC 返回结构，与设计 mock 对齐）
- **账户卡**：`email / provider / status / imapHost+port / smtpHost+port / lastSyncAt / lastErrorCode / 密码已保存(是/否) / 操作（重新设置密码·测试连接·停用·删除）`；**不显示明文密码**。
- **添加/编辑账户表单**：预设下拉、邮箱、显示名、IMAP/SMTP 主机端口加密方式、用户名、密码（只写）、发件显示名；底部【测试连接】结果区（成功=绿条，失败=错误码+修复指引）。
- **规则列表**：`keyword / enabled / mode+scope 摘要（如"精确·仅标题"）/ targets[{path,required,health,freeBytes}] / fileTypes / autoReply / hitMessages / hitFiles / lastHitAt / priority`。
- **规则编辑面板**：上述可编辑字段 + 校验错误（关键词空、路径重复、路径不可写、required 全关时提示"该规则不会阻塞回信"）。
- **记录行**：`time / accountEmail / from / subject / matchedKeyword / attachments[{filename,size}] / deliveries[{targetPath,state,savedName,errorCode}] / status / autoReplyStatus`；展开显示错误详情与"只重试失败路径"按钮。
- **概览**：`listening(bool) / todayMessages / todayMatched / todayFiles / todayFailed / targetsHealth[] / accountsHealth[] / recentRecords[10] / diskFree[]`。
### 11.3 事件推送（主进程 → 渲染层，设计可按事件局部刷新）
| 事件 | 载荷 | 触发 |
| --- | --- | --- |
| `account:changed` | 账户摘要（含 status/errorCode） | 连接/测试/认证状态变化 |
| `message:upserted` | 记录行 | 新邮件处理/聚合状态变化 |
| `delivery:changed` | `{messageId, deliveries[]}` | 任一投递状态变化（记录页行内徽标实时更新） |
| `rules:changed` | 规则摘要 | 规则增删改/热生效后 |
| `health:changed` | 账户/磁盘健康 | 每 30s 或事件触发 |
| `toast` | `{level: 'success'/'warn'/'error', title, body}` | 新件落盘、失败、需重新设置密码 |

> 设计稿若新增字段，请先加到本表与 `src/shared/enums.ts`，再同步 `ipc-contract.ts`，避免"图里有、实现没有"。
## 附录 A：客户必须提供 / 配合的事（部署前清单）
| # | 事项 | 谁做 | 不做的后果 |
| --- | --- | --- | --- |
| A1 | 提供收件邮箱地址（建议 Gmail 或 QQ；Outlook/M365 不支持密码方式） | 客户 | 无法配置 |
| A2 | **Gmail**：先开启两步验证，再生成 16 位应用专用密码（myaccount.google.com/apppasswords） | 客户 | 无法登录 IMAP/SMTP（`IMAP_APP_PASSWORD_REQUIRED`） |
| A3 | **QQ**：邮箱设置中开启 IMAP/SMTP 服务并生成授权码（不是登录密码） | 客户 | 无法登录 |
| A4 | 确认企业邮箱管理员**未禁用 IMAP / SMTP AUTH**，且允许出站 993/465/587 | 客户 IT | 测试连接失败（`IMAP_DISABLED` / `*_UNREACHABLE`） |
| A5 | 提供部署机信息：Windows 版本、盘符规划、是否网络盘、是否自动登录、远程协助方式 | 客户 | 路径无法预配，自启/排障受影响 |
| A6 | 关闭部署机睡眠/休眠；保持 7×24 开机与联网 | 客户 | 休眠期间漏件（可补但实时性不达标） |
| A7 | 确认匹配口径（精确/包含、未命中是否留痕、命中多条策略、兜底路径） | 客户拍板（附录 C） | 该收的没收到/不该收的收了 |
| A8 | 确认附件类型白名单与回信语言/模板；允许远程协助首次配置与验收 | 客户 | 二次返工 / 首次配置失败率高 |
## 附录 B：官方文档索引（实现时逐条对照）
- Gmail IMAP/SMTP 设置与客户端配置：<https://support.google.com/mail/answer/7126229>
- Gmail 应用专用密码（需两步验证）：<https://support.google.com/accounts/answer/185833>
- Gmail 带宽/使用限制：<https://support.google.com/a/answer/1071518>
- Gmail 发信限额：<https://support.google.com/mail/answer/22839>
- QQ 邮箱 IMAP/SMTP 与授权码帮助：<https://service.mail.qq.com/>
- Microsoft 停用 Exchange Online 基本认证（Outlook/M365 不可用依据）：<https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online>
- IMAP IDLE（RFC 2177，29 分钟重发）：<https://datatracker.ietf.org/doc/html/rfc2177>
- 文件名编码 RFC 2047 / RFC 2231：<https://datatracker.ietf.org/doc/html/rfc2047> ／ <https://datatracker.ietf.org/doc/html/rfc2231>
- imapflow 文档：<https://imapflow.com/> ／ nodemailer 文档：<https://nodemailer.com/>
- Electron 安全清单：<https://www.electronjs.org/docs/latest/tutorial/security> ／ safeStorage：<https://www.electronjs.org/docs/latest/api/safe-storage>
- Windows 长路径：<https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation> ／ 误报申报：<https://www.microsoft.com/en-us/wdsi/filesubmission>
## 附录 C：开发前必须冻结的 5 个口径（对应 REQUIREMENTS §9）
| # | 口径 | 未确认前的默认实现 | 影响面 |
| --- | --- | --- | --- |
| C1 | 匹配方式：精确 vs 包含 | 精确（去空格、忽略 RE:/FWD:、全半角归一）；`mode=contains` 可切换 | `rule-engine.ts` + 规则编辑 UI |
| C2 | 未命中邮件是否留痕 | 留痕（`ignored_no_keyword`，可筛选），设置可关闭 | `messages` 写入量、记录页筛选 |
| C3 | 一封邮件命中多条规则 | 全部执行（`multiRuleStrategy='all'`），可切 `priority` | 扇出数量、回信内容 |
| C4 | 多路径存实体副本还是链接 | 实体复制（更稳，占多份空间） | 磁盘占用、写入耗时 |
| C5 | 兜底默认路径（未命中但带 ZIP/TIF） | 默认关闭，预留开关 | 防漏件策略、概览统计 |
