# MailHarbor · 高保真设计稿 v1.0

> 对应需求：`docs/REQUIREMENTS.md` **v0.2**（关键词触发规则 + 一条关键词多路径）
> **v0.3 变更（2026-11-22）**：客户明确「邮箱设置要用 SMTP，不是授权」→ 邮箱改为 **IMAP 收信 / SMTP 回信手填**，**取消 Gmail OAuth 整套**（无 Google Cloud、无 client_id、无浏览器授权、无 refresh_token）。见 §3.2、§5.1。
> 对应架构：`docs/ARCHITECTURE.md` §11（状态枚举 / 字段 / 事件）
> 设计语言：**「印刷工坊的纸与墨」Paper & Ink**
> 交付日期：2026-11-22　｜　设计：designer　｜　状态：**待客户拍板**（待确认项见 §9）

---

## 0. 怎么用这份稿子

| 文件 | 用途 |
| --- | --- |
| `design/tokens.css` | **唯一的设计令牌来源**（纯 CSS 变量，三层：primitive → semantic → component）。开发直接 `import`。 |
| `design/mockups/screens/01…06.html` | 6 张 1440×900 自包含 HTML（`tokens.css` 已内联，可离线双击打开，无外网资源）。改完稿可直接当视觉回归基线。 |
| `design/exports/*.png` | 上述 6 屏的 2× 导出图（2880×1800），用于评审与开发比对。 |
| `design/mockups/README.md` | 本文件：视觉语言、每屏 IA、状态清单、状态枚举对齐、组件映射、实现要点、断点。 |

**阅读顺序建议**：`01 概览`（整体调性）→ `03 触发规则`（业务核心，最重要）→ `05 记录`（结果如何呈现）→ `02 账户`（最容易被卡住的一步，现在是手填 IMAP/SMTP）→ `04 自动回复` → `06 组件`（开发照着建组件）。

> ⚠️ HTML 里的令牌是**构建时从 `tokens.css` 内联**的副本。若修改 `tokens.css`，HTML 不会自动更新；正式实现请直接引用 `tokens.css`，把 HTML 当作状态/尺寸的基准图。

---

## 1. 视觉语言：为什么「纸与墨」适合这个软件

客户是 **POD 印刷工厂**，软件做的是「把图稿归档成工单」。设计把纸厂的**未涂布艺术纸 + 深墨 + 朱红印章**搬到屏幕：
米白纸底降低长时盯屏的疲劳（工厂电脑 7×24 开着），深墨蓝正文保证 1366×768 下的可读性，朱红只出现在**状态与危险动作**上，于是「红色出现 = 有事发生」。它不像通用 SaaS 模板，一眼能看出是做印刷/生产的内部工具，符合「不用培训」的目标。

### 1.1 颜色
| 角色 | 令牌 | 值 | 用途 |
| --- | --- | --- | --- |
| 纸 · 画布 | `--paper-100` / `--color-bg-app` | `#FAF7F0` | 应用底色 |
| 纸 · 侧栏 | `--paper-200` / `--color-bg-chrome` | `#F5F1E7` | 侧边栏、标题栏 |
| 纸 · 卡片 | `--paper-050` / `--color-bg-surface` | `#FCFAF4` | 卡片、面板 |
| 纸 · 浮层 | `--paper-000` / `--color-bg-raised` | `#FDFBF6` | 弹窗、输入框、邮件预览 |
| 墨 · 正文 | `--ink-900` / `--color-text-primary` | `#16202B` | 主文字 |
| 墨 · 次级 | `--ink-700` / `--color-text-secondary` | `#333F4C` | 表格正文 |
| 墨 · 辅助 | `--ink-500` / `--color-text-tertiary` | `#5E6873` | 说明文字（≥4.5:1） |
| 朱红 · 强调 | `--vermilion-500` / `--color-accent` | `#C8422D` | 主按钮、选中、印章、焦点环 |
| 成功 | `--green-600` | `#2C6B4B` | 监听中、已归档、账户已启用 |
| 警告 | `--amber-600` | `#96660F` | 部分完成、低空间、需处理 |
| 错误 | `--red-600` | `#B4341F` | 待重试、路径不可用、过期 |
| 信息 | `--slate-600` | `#2C5567` | 处理中、向导提示 |

**规则**：同一屏最多 1 个朱红实心按钮（主行动）。状态色只用于徽章/圆点/左标条，**不整行铺色**。

### 1.2 字体（中文是主角，全部系统字体、零网络请求）
| 角色 | 字体栈 | 用法 |
| --- | --- | --- |
| 标题 / 页面名 / 印章 | `"Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC","SimSun",serif` | 页面标题 24–28px、卡片标题 16–18px、印章 |
| 正文 / 控件 | `"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif` | 正文 15px 起、表格 12.5–13.5px |
| 英文/拉丁小字 | `"Avenir Next","Avenir","Segoe UI","Helvetica Neue",sans-serif` | Eyebrow、品牌名 |
| 数字/时间/大小/路径 | `"SF Mono","Menlo","Consolas","Cascadia Mono","DejaVu Sans Mono",ui-monospace,monospace` + `font-variant-numeric: tabular-nums` | 所有数字必须等宽对齐 |

- **Windows 落地**：`Songti SC` → 系统 `SimSun/宋体` 或随安装包附带「思源宋体 SC（Source Han Serif）」；正文 `Microsoft YaHei UI`；数字 `Consolas`（Win 自带）。
- **字号阶梯**：10/11/12/13/14/15/16/18/22/28/34/44，正文默认 **15px**，正文行高 1.6。
- **时间格式统一**：`2026-11-22 15:44`（表格列内用等宽 11px，正文内 12–13px）；日期区间 `2026-11-01 – 11-22`。

### 1.3 材质与精度
- **发丝线**：所有分隔线 1px，墨色 10% 透明度（`--rule-hairline`）；表格行分隔用 **1px 点线**（`--color-rule-dotted`），像印刷工单的虚切。
- **圆角**：2/3/4/6/8px，**不做胶囊按钮**；开关与状态点是唯一圆形。
- **阴影**：极克制的「纸片叠放」，卡片只用 `--shadow-xs`，浮层 `--shadow-lg/--shadow-xl`，窗口 `--shadow-window`。
- **纸纹**：画布叠 2.8–5% 的 SVG 噪点（内联 data URI），远处看不出、近看有纸感；桌面背景加印刷对位角标（crop marks）。
- **动效**：≤ 240ms，`cubic-bezier(.2,.75,.3,1)`；仅三处动效：监听呼吸点（2.4s）、折叠/悬停 120–160ms、toast 进出。**遵守 `prefers-reduced-motion`**。
- **记忆点**：① 概览顶部「日报工单条」+ 朱红「监听中」印章；② 多路径 `D:✔ E:✔ F:✖` 的路径 chip；③ 侧栏底部常驻运行卡。

### 1.4 明确禁止（客户 + 设计双重要求）
紫色渐变 / 玻璃拟态 / 3D 图标 / emoji 当图标 / 大圆角卡片堆叠 / 英文 SaaS 模板感 / 动态背景。

---

## 2. 设计令牌（`design/tokens.css`）

三层结构，**开发只引用 semantic / component 层，不直接用 primitive**：

```
primitive（--paper-*、--ink-*、--vermilion-*、--green-*…）
   ↓
semantic（--color-bg-*、--color-text-*、--color-success/warning/danger/info、--rule-*、--shadow-*、--dur-*、--ease-*）
   ↓
component（--control-h-*、--row-h-*、--icon-*、--window-*、--sidebar-w、--z-*…）
```

| 组 | 关键令牌 | 值 |
| --- | --- | --- |
| 间距 | `--space-1…15` | 2/4/6/8/10/12/16/20/24/28/32/40/48/56/64（4px 基数） |
| 圆角 | `--radius-xs…window` | 2/3/4/6/8/8 |
| 字号 | `--text-2xs…5xl` | 10–44px，正文 `--text-base: 15px` |
| 控件高 | `--control-h-sm/md/lg` | 30 / 36 / 40 |
| 行高 | `--row-h-compact/base/comfy` | 36 / 44 / 56 |
| 图标 | `--icon-sm…xl` | 14/16/18/22（内联 SVG，stroke 1.6，viewBox 24） |
| 布局 | `--window-w/h` `--titlebar-h` `--sidebar-w` `--content-pad-*` `--grid-gap` | 1408×868 / 40 / 236 / 24×20 / 16 |
| 焦点 | `--focus-ring` | `0 0 0 2px 纸底, 0 0 0 4px rgba(200,66,45,.55)` |

`tokens.css` 内的 `@media (prefers-reduced-motion: reduce)` 会把 4 个时长令牌置 0，因此**所有动效必须走 `var(--dur-*)`**，不要硬编码 ms。

---

## 3. 每屏信息架构与关键交互

> 所有屏幕：1440×900 视口（窗口 1408×868，Windows 标题栏 40px，侧栏 236px，内容区 1172px，内边距 24/20）。

### 3.1 `01-dashboard.html` · 概览

![概览](../exports/01-dashboard.png)

- **结构**：页面头（标题 + 时间 + 检查/暂停）→ **日报工单条**（今日收件 14 / 命中 12 / 归档 23 / 回信 12 / 失败 2 + 「监听中」印章）→ 三卡（运行状态｜邮箱账户健康｜目标盘剩余空间）→ 底部（最近收件表 + 失败待重试卡）。
- **关键交互**
  - `暂停监听` 主按钮 ⇄ `恢复监听`（三处同步：状态灯、文案、按钮）。
  - 「失败待重试」卡片：每个失败项显示**只在失败路径上重试**，脚注明确「D: 与 E: 已写入成功，重试只补写 F:」。
  - 目标盘卡：D 正常 / E 空间不足（91% 已用，琥珀）/ F 不可用（红，`2 条规则受影响` + [检测]）。
  - 表格行 hover 显示完整路径 tooltip；`最近收件` 只给概览摘要，点「全部记录 ›」进 05。
- **P0 状态**：监听中（本屏）；已暂停在 `06` 组件页并列展示。

### 3.2 `02-accounts.html` · 邮箱账户（IMAP 收信 / SMTP 回信，手填）

![邮箱账户](../exports/02-accounts.png)

> **v0.3 重做**：客户要求「邮箱设置用 SMTP，不要授权」。本屏已彻底移除 OAuth 三步向导，改为类 Foxmail / Outlook 的**手填服务器设置**。全屏不再出现「授权 / OAuth / Google Cloud / client_id」字样。

- **结构（主从双栏）**
  - **左｜已添加账户**：3 张账户卡 + 安全条 + 折叠的「常见问题」。
    - 卡字段：`邮箱地址 / 服务商·主备·添加日期` + **服务器 chip**（`IMAP imap.gmail.com:993 · SSL`、`SMTP smtp.gmail.com:465 · SSL`）+ `今日收件 / 累计归档 / 上次检查 / 最近一次测试` + 行内操作（`测试连接`·`编辑`·`停用`）。
    - 三种状态：**已启用**（绿左标）/ **连接失败**（红左标 + 红横幅写明 `535 用户名或密码不正确`、已失败 3 次、并提示「Gmail 要填应用专用密码」）/ **已停用**（灰，设置保留、启用无需重填）。
  - **右｜添加邮箱账户表单**（472px）
    1. **服务商预设**：`Gmail / Google Workspace / QQ 邮箱 / Outlook / 自定义` 分段选择；选中自动填主机与端口，并有一行提示「已自动填入 imap.gmail.com:993 与 smtp.gmail.com:465（SSL）」，**全部字段仍可手改**。
    2. **① 收件服务器 IMAP**：服务器地址 + 端口 + **加密方式（SSL/TLS · STARTTLS · 不加密）** + 账号 + 密码（掩码、可显示），密码标签直接写「应用专用密码」，下方朱红提示「Gmail 填应用专用密码（16 位），不是邮箱登录密码」。
    3. **② 发件服务器 SMTP**：同结构 + **「与收件相同账号」开关**（开时账号/密码沿用 01，显示为禁用态「沿用 01 账号」；关掉可单独填发件账号）。
    4. **连接测试**：一次点击**分别测 IMAP 与 SMTP**，两行结果各带 `IMAP/SMTP` 标签、成功图标、主机端口、耗时（312ms / 428ms）；下方说明「失败会写明原因：535 认证失败 / IMAP 未开启 / 端口超时；两项都通过才能保存」。
    5. **底部**：`密码仅存本机 · DPAPI 加密` 安全感文案 + `取消` / `保存并启用`。
  - **常见问题（折叠）**：Gmail 应用专用密码怎么开（两步验证 → 应用专用密码）、QQ 邮箱授权码在哪（设置 → 账户 → 开启 IMAP/SMTP → 短信 → 16 位授权码）、端口被封怎么办（改 STARTTLS：IMAP 143 / SMTP 587，或让 IT 放行）。
- **关键交互**：改任何字段 → `测试连接` 分别校验 IMAP/SMTP → 全绿才允许 `保存并启用`；账户卡上也有 `测试连接`，失败卡的主按钮是 `检查设置`（跳到编辑态并高亮密码框）。
- **P0 状态**：**邮箱连接失败（密码错误）**（本屏，红横幅 + 徽章 + 检查设置按钮 + 服务器 chip 变暗四重表达）。

### 3.3 `03-rules.html` · 触发规则 ★ 业务核心

![触发规则](../exports/03-rules.png)

- **结构（主从双栏）**
  - **左 340px｜关键词规则列表**：搜索 → 6 条规则（1–4 启用、5–6 已停用，分隔标签「已停用 · DISABLED」）→ 虚线「新增关键词规则」。每条 = 拖拽手柄 + 优先级序号 + 关键词 + 副标题（`N 个路径 · 最近 HH:MM · 命中 M 封`）+ 启用开关；**有路径不可用时路径数变红并带 ⚠**。底部「拖拽调整优先级 / 按优先级从上到下执行」。
  - **右｜选中规则编辑面板**：`01 匹配条件`（关键词、匹配范围 仅标题/标题+正文、匹配方式 精确/包含）→ `02 目标路径`（**本屏主角**）→ `03 接收的附件类型`（ZIP/TIF/TIFF/JPG/PNG/PDF 复选）+ 自动回信 → `04 本规则最近命中`（3 条内联结果）→ 底部保存条「改动立即生效 · 上次保存 15:41:08」。
- **「1 个文件 → N 个路径」怎么表达（本设计的关键决策）**
  1. 分区标题右侧一行等宽字：`1 个附件 → 复制 3 份 · 2 份必达`；
  2. 每条目标路径前用**文件树缩进符 `├ / └` + 序号**，读起来像资源管理器的分叉，而不是流程图；
  3. 每行四件套：`[可编辑路径] [剩余空间 + 占用条] [必达开关] [打开↗] [删除]`；
  4. 底部一条语义说明：「必达路径任一失败 → 该邮件标记待重试，只重试失败路径；**非必达**路径失败只记录、不阻塞回信；已写入的文件夹不会重复写」。
  5. 第 3 条 `F:\POD\归档\卡套` 是**路径不可用**示例：红底、红边框、`磁盘未连接 · 路径不可用`、必达关闭（尽力而为）、[重新检测]。
- **交互**：关键词可改（带光标与铅笔图标的可编辑框）；增删路径；浏览文件夹；启停开关；复制/删除规则（删除走模态）；搜索无结果时列表区显示空提示（完整空态见 06）。
- **热生效**：所有改动点「保存规则」即生效，右侧底部明确写「改动立即生效 · 无需重启」。

### 3.4 `04-autoreply.html` · 自动回复

![自动回复](../exports/04-autoreply.png)

- **结构**：左列 = 总开关条（今日 12 / 本周 68 / 失败 0 / 上限 60）→ 模板卡（语言分段：中文/English/中英双语；主题行；模板编辑器；变量插入条）→ 发送设置（延迟 10 秒、同线程只回一次、全部必达成功才回信、发送测试信）；右列 = **真实邮件样子的实时预览**。
- **变量**：`{关键词}` `{文件名}` `{数量}` `{时间}`，在编辑器里是高亮 token（朱红底），预览里已用最近一封邮件填充；右侧注明预览数据来源并可「换一封」。
- **防轰炸**：模板主题保留客户原标题（`Artwork received — {关键词}`），保证线程归并；预览底部注明「客户回信时主题保持不变」。
- **预演**：邮件预览含邮件头（发件人/收件人/时间）、正文、签名、`由 MailHarbor 自动发送` 页脚、以及**引用原文**（原始邮件 From/Subject/Attach）——让客户一眼确认「发出去长这样」。

### 3.5 `05-records.html` · 下载记录

![下载记录](../exports/05-records.png)

- **结构**：筛选条（搜索 / 状态分段 全部 1,284·已归档·待重试 2·已忽略 / 账户 / 日期 / 更多筛选）→ 9 行两行式表格 → 分页。
- **列**：`时间 | 账户 | 发件人 | 主题/附件+大小 | 命中规则 | 各目标路径 | 状态 | 操作`。主题列两行：上行邮件主题、下行附件名 + 大小（等宽）。
- **多路径结果**：`D:✔ E:✔ F:✖` 彩色 chip；**失败路径可单点重试**：`部分完成` 行给「重试 F」，`待重试` 行给「重试 E」（红色，因为该条必达失败）。
- **状态样本**：处理中（行首 pink 高亮 + 转圈）、部分完成（琥珀）、已归档（绿）、待重试（红）、已忽略（灰，未命中规则）。
- **交互**：行内 [打开文件夹]、失败行 [重试 X路径]、点击路径 chip 看失败原因、导出 CSV、「打开存储文件夹」。
- **空状态**：本屏展示满数据（真实业务密度）；**列表空状态**放在 `06`（含「首次使用」完整设计），另在 03 左侧列表给出「搜索无结果」的轻量内联空提示。

### 3.6 `06-components.html` · 组件与状态总览

![组件总览](../exports/06-components.png)

四行布局：① 运行状态两态（**监听中 / 已暂停**）+ 按钮矩阵（主要/次要/深墨/危险 × 默认/悬停/聚焦/禁用）+ 输入框四态与开关；② 状态徽章（记录 5 态 / 账户 5 态 / 投递 6 态 / 规则与账户 chip）+ Toast 两型 + **关键词列表空状态**；③ 托盘右键菜单 + 危险确认模态框 + 表格行三态；④ 色板与字体样张。

---

## 4. 状态与边界情况清单

### 4.1 必画的 4 个 P0 状态（评审索引）

| # | P0 状态 | 出现位置 | 视觉表达 |
| --- | --- | --- | --- |
| 1 | **监听中 / 已暂停** | `01`（监听中，工单条印章 + 状态灯 + 按钮）、`06`（两态并列） | 绿呼吸点 vs 灰点；印章「监听中」vs 灰；主按钮「暂停监听」⇄「恢复监听」 |
| 2 | **邮箱连接失败**（密码错/设置错） | `02`（账户卡 + 红横幅 + 检查设置按钮 + 服务器 chip 变暗）、`01`（邮箱卡行内 + 检查设置按钮）、侧栏警示点 | 红左边条 + 「连接失败」徽章 + 红横幅写明 535 与「要用应用专用密码」+ 主按钮「检查设置」 |
| 3 | **某目标路径不可用** | `03`（路径行红底 + 重新检测）、`01`（目标盘卡 F 不可用）、`05`（F:✖ chip） | 红底/红边/红字三件套 + 关闭必达 + 说明「该路径失败不影响其他路径」 |
| 4 | **部分路径成功 / 失败待重试** | `05`（✔✔✖ + 单路径重试）、`01`（待重试卡）、`03`（最近命中 ✔✔✖） | chip 逐路径标注 + 状态徽章 + 只重试失败路径的按钮 |

> 另有 **关键词列表空状态**（P0 清单第 5 项）在 `06` ②中完整呈现：分拣托盘线稿 + 「还没有任何关键词规则」+ [新增关键词] / [导入预设 3 条]。

### 4.2 全量边界清单

| 类别 | 状态 | 图纸位置 | 处理约定 |
| --- | --- | --- | --- |
| loading | 邮件处理中（下载/扇出） | 05 首行、06 投递 `copying` | 行首浅朱红底 + 转圈图标；路径 chip 显示正在写哪条 |
| loading | 规则列表/记录加载骨架 | 未画 | 用纸色骨架块（不闪白），≥300ms 才出现 |
| empty | 关键词列表为空（首次使用） | 06 ② | 分拣托盘线稿 + 两个主行动 |
| empty | 搜索/筛选无结果 | 03 左侧内联提示 | 轻量点线框 + 「清除搜索」 |
| empty | 记录筛选无结果 | 未画（同 06 空态复用文案「没有符合条件的记录」+ 清除筛选） | — |
| error | 下载失败（重试中） | 05「待重试」、01 待重试卡 | 红徽章 + 仅失败路径重试 |
| error | 重试耗尽 `failed` | 05 可扩展到第 4 次后 | 红色 + 「需人工处理」，不弹窗打断 |
| error | 磁盘写入失败 / 无权限 | 03 路径行、06 输入 error 态 | 行内红字说明原因，不阻塞其它路径 |
| offline | 网络离线 | 02 账户卡（`offline` 枚举已备）、标题栏 | 琥珀点 + 顶部条「网络不可达，自动重试，不打扰」 |
| offline | Gmail API 5xx / 限流 | 同一通道 | 指数退避，UI 只显示「稍后自动重试」 |
| auth | **密码错误 / 应用专用密码未生效**（IMAP 535） | 02 连接失败卡、01 邮箱行 | 红横幅 + 兜底文案「Gmail 要填应用专用密码，不是登录密码」；修好后自动恢复并补收期间邮件 |
| auth | **服务器设置错误**（主机/端口/加密不匹配、未开 IMAP） | 02 表单 + 测试结果行 | 测试行写明 `IMAP 未开启` / `TLS 握手失败` / `端口超时`，保存按钮保持禁用 |
| auth | 账户待测试（刚添加/刚改设置） | 02（枚举 `pending_test`）、06 ② | 「待测试」灰徽章 + 主按钮「测试连接」 |
| paused | 用户暂停监听 | 06 ① | 灰点 + 灰印章 + 队列提示「已在队列的任务仍会完成」 |
| warning | 目标盘空间不足（<阈值/剩 2GB） | 01 盘卡、04 toast warn | 琥珀 + 具体 GB + 建议动作 |
| warning | 回信被抑制（同线程已回过） | 05 行状态/回信列 | `suppressed` → 「已抑制（同线程）」灰徽章 |
| disabled | 账户停用 / 规则停用 | 02、03 | 去饱和 + 「已停用」中性徽章；仍可查历史 |

---

## 5. 状态枚举对齐表（对齐 `docs/ARCHITECTURE.md` §11.1）

> 颜色一栏写 **令牌名**，开发直接用 `var(--...)`；「图纸位置」写本稿中已呈现的位置。
> 统一原则：**枚举值 = 数据；中文文案 = 给操作员看的；文案不得出现英文枚举名**。

### 5.1 账户状态 `AccountStatus`（6 态）· v0.3 口径（IMAP/SMTP，无授权概念）

> ⚠️ **契约变更**：`docs/ARCHITECTURE.md` §11.1 的 `pending / ok / needs_reauth / offline / error / disabled` 需改为下表；§11.2 账户卡字段需改为 `email / provider / status / imap{host,port,secure,user} / smtp{host,port,secure,user,reuseImap} / lastSyncAt / lastError{code,message,at} / todayCount / totalFiles`。请先改 `src/shared/enums.ts` 与 `ipc-contract.ts`，再按图实现。

| 枚举值（建议） | 文案 | 触发条件 | 样式类 | 颜色令牌 | 图纸位置 |
| --- | --- | --- | --- | --- | --- |
| `enabled` | 已启用 | 最近一次 IMAP+SMTP 测试通过，正在轮询 | `.badge-ok` | `--color-success` + `--color-success-bg/border` | 01、02、06 |
| `pending_test` | 待测试 | 刚添加 / 刚改设置，尚未跑过测试 | `.badge-outline` | `--color-text-tertiary` | 02（新增态）、06 ② |
| `auth_failed` | 连接失败（密码/设置） | IMAP 535、应用专用密码失效、未开 IMAP | `.badge-bad` + 红横幅 `.acct-alert` | `--color-danger` + `--color-danger-bg/border` | 02 第二张卡、01 邮箱行、06 ② |
| `conn_failed` | 连接失败（网络/端口） | DNS 失败、TLS 握手失败、993/465 被拦、超时 | `.badge-bad`（横幅文案不同） | `--color-danger` | 02 测试结果行、06 ②（并入「连接失败」） |
| `offline` | 网络离线 | 整机出站不可达，自动重试、不打扰 | `.badge-warn` | `--color-warning` | 06 ② |
| `disabled` | 未启用 | 用户手动停用，不轮询；设置与密码保留 | `.badge-neutral` + 灰左标 | `--color-text-tertiary` + `--paper-300/500` | 02 第三张卡、06 ② |

**测试结果行（不落枚举，属瞬时态）**：`.test-line .res.ok`（`--color-success`）/ `.res.bad`（`--color-danger`），每行固定三段：`IMAP|SMTP` 标签 → 结果文案（登录成功 / 535 认证失败 / IMAP 未开启 / 端口超时 / TLS 握手失败）→ 耗时或错误码。错误码为等宽 9.5px。

### 5.2 邮件聚合状态 `MessageStatus`（6 态）

| 枚举值 | 文案（§11.1） | 样式类 | 颜色令牌 | 图纸位置 |
| --- | --- | --- | --- | --- |
| `ignored_no_keyword` | 未命中关键词 | `.badge-neutral` + 规则列「—」 | `--color-text-tertiary` | 05 第 6 行 |
| `ignored_type` | 附件类型不符 | `.badge-neutral` | `--color-text-tertiary` | 未画（同型复用） |
| `queued` | 处理中 | `.badge-info` + `.spin` | `--color-info` | 05 第 1 行 |
| `partial` | 部分成功 · 待重试 | `.badge-warn` | `--color-warning` | 05 第 2 行、01 |
| `done` | 已完成 | `.badge-ok` | `--color-success` | 05 多数行 |
| `failed` | 失败 | `.badge-bad` | `--color-danger` | 05 第 5 行（文案取「待重试」，见 §9 D2） |

### 5.3 投递状态 `DeliveryState`（6 态，每封邮件 × 每条路径一个）

| 枚举值 | 文案（§11.1） | 徽标（本稿用 SVG 而非 unicode） | 样式类 | 颜色令牌 | 图纸位置 |
| --- | --- | --- | --- | --- | --- |
| `pending` | 排队中 | 时钟 | `.pchip-pending` | `--ink-500` + `--paper-300` | 06 ② |
| `copying` | 复制中 | 时钟（info 色） | `.pchip-copy` | `--color-info` | 06 ②、05（`.spin`） |
| `done` | 已写入 | ✔ | `.pchip-ok` | `--color-success` | 05、01、03 |
| `retry_wait` | 等待重试 | ⚠ + 倒计时 | `.pchip-retry` | `--color-warning` | 06 ②、05（重试链接） |
| `failed` | 重试失败 | ✖ | `.pchip-bad` | `--color-danger` | 05、01、03 |
| `skipped` | 已跳过 | – | `.pchip-skip` | `--color-text-quaternary` | 06 ② |

> chip 结构：`<span class="pchip pchip-ok"><b>D</b>{icon}</span>` —— 盘符粗体、图标 9–10px，`title` 带完整路径（`D:\POD\生产\卡套 · 已写入 15:44`）。

### 5.4 回信状态 `ReplyStatus`（5 态）

| 枚举值 | 文案 | 样式类 / 表达 | 颜色令牌 | 图纸位置 |
| --- | --- | --- | --- | --- |
| `disabled` | 回信已关闭 | 记录行/规则页灰字 + 关闭开关 | `--color-text-tertiary` | 03（自动回信开关）、04（总开关） |
| `pending` | 等待中 | `.badge-info` + 文案「等待必达路径完成」 | `--color-info` | 03 说明条、04 设置项 |
| `suppressed` | 已抑制（同线程） | `.badge-neutral` | `--color-text-tertiary` | 05（可扩展列）、04「同线程只回一次」 |
| `sent` | 已回信 | `.badge-ok` | `--color-success` | 01 工单条「已自动回信 12 封」、04 stats |
| `failed` | 回信失败 | `.badge-bad` | `--color-danger` | 04 发送失败计数、可复用 toast |

### 5.5 路径可用性 `TargetHealth`（4 态）

| 枚举值 | 文案 | 样式类 | 颜色令牌 | 图纸位置 |
| --- | --- | --- | --- | --- |
| `ok` | 正常 · 剩余 xx GB | `.tgt` 默认 + `.pchip-ok` | `--color-success` | 03 路径 1/2、01 盘卡 D |
| `low_space` | 低空间（<2GB / 阈值） | `.tgt.is-warn` + `.meter i.warn` | `--color-warning` + `--color-warning-bg` | 03 路径 2（46GB 91% 已用）、01 盘卡 E |
| `unavailable` | 不可用：盘不存在 / 无权限 | `.tgt.is-bad` + `.badge-bad` | `--color-danger` + `--color-danger-bg/border` | 03 路径 3、01 盘卡 F、05 F:✖ |
| `unknown` | 未检测 | `.badge-outline` + [检测] 按钮 | `--color-text-tertiary` | 01 盘卡 F 的「检测」、03「重新检测」 |

---

## 6. 组件与 React 映射（开发照此建组件）

> 建议目录：`src/renderer/components/`；CSS 一律用 `design/tokens.css` 变量，不再新建色值。
> 尺寸：按钮 36（`sm` 30 / `lg` 40）、输入 36（紧凑 30）、表格行 44–48、卡片圆角 6。

| CSS class（图纸中） | React 组件 | 关键 props | 说明 / 实现约定 |
| --- | --- | --- | --- |
| `.btn` `.btn-primary` `.btn-ink` `.btn-ghost` `.btn-danger` | `<Button>` | `variant: 'primary'\|'ink'\|'secondary'\|'ghost'\|'danger'`、`size: 'sm'\|'md'\|'lg'`、`loading`、`icon` | 状态：`:hover` `:active` `:focus-visible` `[disabled]`；`active` 只加深+内阴影，**不改尺寸** |
| `.icon-btn` | `<IconButton>` | `icon`、`label`（必填 aria-label）、`tone: 'default'\|'danger'\|'ok'` | 28×28，触达区 ≥ 32 |
| `.badge` `.badge-ok/-warn/-bad/-info/-neutral/-accent/-outline` | `<StatusBadge>` | `tone`、`children`、`dot?: boolean` | 由 §5 枚举映射生成，**不要各页自写颜色** |
| `.pchip` `.pchip-ok/-bad/-pending/-copy/-retry/-skip` | `<PathChip>` | `drive: 'D'`、`state: DeliveryState`、`path`、`freeBytes?`、`onRetry?` | 盘符 + 状态图标；`title` 展示完整路径；失败态可点 |
| `.kchip` | `<KeywordChip>` | `keyword`、`muted?`、`onClick?` | 命中规则标签（`原图+卡套`） |
| `.t-acct` | `<AccountChip>` | `label: '主账号'\|'备账号'` | 记录页账户列 |
| `.sw` `.sw.sm/.md/.lg` | `<Switch>` | `checked`、`size`、`disabled`、`label` | 必达开关用 `accent` 变体；`role="switch"` |
| `.checkbox.is-checked` | `<Checkbox>` | `checked`、`label` | 白名单文件类型用 `.ftype` 包一层 |
| `.input` `.is-focus` `.is-error` `.is-disabled` `.mono-input` | `<TextField>` / `<PathInput>` | `value`、`error`、`hint`、`mono`、`suffix` | 原生 `<input>` 包壳；错误态 `aria-invalid` |
| `.seg` `.seg-item` | `<SegmentedControl>` | `value`、`options`、`onChange` | 匹配范围/方式、记录状态筛选、模板语言 |
| `.field` `.label` `.hint` | `<Field>` | `label`、`required`、`hint`、`error` | label 用 `htmlFor` 关联 |
| `.card` `.card-hd` `.card-bd` `.card-ft` | `<Card>` | `title`、`note`、`footer` | 统一 1px 边 + `--shadow-xs` |
| `.table` `.rec-table` | `<DataTable>` | `columns`、`rows`、`dense`、`onRowClick` | 行分隔用点线；hover 3%；选中左标 2px 朱红 |
| `.ticket` `.tstat` `.stamp` | `<DailyTicket>` | `date`、`stats[]`、`stamp` | 概览记忆点，可整块复用 |
| `.state-card`（06） | `<RunStateCard>` | `listening: boolean`、`onToggle` | 两态：监听中/已暂停 |
| `.empty` + `TrayArt` | `<EmptyState>` | `title`、`desc`、`actions[]`、`variant: 'full'\|'compact'` | 线稿 SVG 见 06，可提取为 `<TrayArt/>` |
| `.toast` | `<Toast>` | `level: 'success'\|'warn'\|'error'`、`title`、`body`、`onClose` | 对应事件 `toast`（§11.3），右上角、4s、不阻塞 |
| `.tray-menu` | `<TrayMenu>`（主进程原生菜单的视觉稿） | — | Windows 托盘菜单用原生 `Menu.buildFromTemplate`，此图仅定信息架构与顺序 |
| `.modal-card` | `<ConfirmDialog>` | `title`、`desc`、`confirmText`、`danger` | 删除规则/账户用；Esc 关闭、默认焦点在「取消」 |
| `.rule-item`（03） | `<RuleListItem>` | `rule`、`active`、`onToggle`、`onSelect` | 含拖拽手柄（`dnd-kit` 排序） |
| `.tgt`（03） | `<TargetPathRow>` | `target{path,required,health,freeBytes}`、`onEdit/onOpen/onRemove/onProbe` | 文件树缩进符由 `index === last ? '└' : '├'` 生成 |
| `.drive-row`（01） | `<DriveMeter>` | `letter`、`label`、`freeBytes`、`totalBytes`、`health` | 占用条 >90% 转琥珀 |
| `.meter` | `<Meter>` | `value`、`tone` | 3–4px 高 |
| `.filters` `.f-search` `.f-select` | `<FilterBar>` | — | 记录页；`Ctrl K` 聚焦搜索 |
| `.preset-seg` `.preset` | `<ProviderPresets>` | `value: 'gmail'\|'workspace'\|'qq'\|'outlook'\|'custom'`、`onChange` | 选中后回填 IMAP/SMTP 主机端口，字段仍可改 |
| `.srv-block` | `<ServerBlock>` | `role: 'imap'\|'smtp'`、`value{host,port,secure,user,password}`、`disabledFields` | 一个块=一组服务器设置；SMTP 侧带「与收件相同账号」开关 |
| `.enc-seg` `.enc` | `<EncryptionPicker>` | `value: 'ssl'\|'starttls'\|'none'` | SSL/TLS(993/465) · STARTTLS(143/587) · 不加密 |
| `.same-acct` | `<Switch inline>` | `checked`、`label` | 「与收件相同账号」，开时 SMTP 账号/密码沿用 IMAP |
| `.test-zone` `.test-line` `.test-note` | `<ConnectionTest>` | `results: [{protocol:'imap'\|'smtp', ok, latencyMs, errorCode?, message}]`、`onTest`、`testing` | 一次点击分别测 IMAP+SMTP；两项全绿才允许保存 |
| `.acct` `.acct-hd` `.acct-stats` `.acct-alert` | `<AccountCard>` | `account`、`status`、`onTest/onEdit/onToggle/onDelete` | 三种状态：已启用/连接失败/未启用；失败卡主按钮为「检查设置」 |
| `.srv` | `<ServerChip>` | `protocol`、`host`、`port`、`secure` | 账户卡上的 `IMAP imap.gmail.com:993 · SSL` |
| `.faq-card` `.faq-item` | `<FaqList>` | `items[{q,a}]`、`defaultOpen` | 折叠帮助：应用专用密码 / QQ 授权码 / 端口被封 |
| `.art-tray` | `<TrayArt>` | `size` | 空状态线稿，颜色继承 `currentColor` + 一处朱红 |

**图标**：全部内联 SVG（viewBox 24、stroke 1.6、round caps），代码里抽成 `<Icon name>` 组件；尺寸只用 `--icon-sm/md/lg/xl`。**禁止 emoji 与图标字体**。

---

## 7. 实现要点（尺寸 / 栅格 / 结构约定）

### 7.1 窗口与栅格
```
窗口 1408×868（在 1440×900 视口居中，四周 16px 桌面留白）
├─ 标题栏 40px（Windows 控件在右：最小化/最大化/关闭到托盘，各 46×40）
└─ 主体 flex: 侧栏 236px（右边框 1px）｜内容 1172px
   内容：padding 20/24，纵向 flex-col + gap 10~14
   卡片栅格：gap 16，常用 300 / 1fr / 1.06fr 与 1fr / 336
```
- 表格列宽写死（百分比会抖）：记录页 `时间 116 · 账户 58 · 发件人 146 · 主题 auto · 命中规则 92 · 路径 104 · 状态 82 · 操作 104`。
- 概览最近收件：`时间 74 · 邮件 auto · 命中规则 104 · 路径 124 · 状态 84`。
- 03 规则页左栏固定 340px，右栏自适应。

### 7.2 结构约定（HTML 骨架 = 后续 JSX 结构）
```html
<div class="win">
  <header class="titlebar">…品牌 + 当前页 + 窗口控件…</header>
  <div class="win-body">
    <aside class="sidebar">…nav-item(is-active)…run-card…</aside>
    <main class="content">
      <header class="page-head">…eyebrow + h1.page-title + p.page-sub + .ph-actions…</header>
      <!-- 每屏主体 -->
    </main>
  </div>
</div>
```
- 页面标题统一 `.page-title`（宋体 27–28/600）；区块标题 `.card-title`（宋体 17）；表单标签 `.label`（12px `--ink-500`）。
- 一等信息用宋体 + 墨 900；二等用 13–14px 墨 700；三等用 11–12px 墨 500；数字/路径**必须** `.mono`（等宽 + tabular）。
- 焦点：所有可交互元素 `:focus-visible` 用 `--focus-ring`，不要 `outline: none` 了事。
- 状态色只出现在徽章、圆点、左边标（3px/2px）与说明条，**不做整行铺色**（失败行只在左侧加 2px 红标）。

### 7.3 字体与数字
- 数字列 `text-align: right` + `font-variant-numeric: tabular-nums`（`.mono` 已内置）。
- 时间统一 `YYYY-MM-DD HH:mm`；表格内可省年份（`15:44`）但同列必须一致；跨天显示完整日期。
- 文件大小：`18.4 MB`（1 位小数，≥1GB 用 `1.2 GB`）。
- 路径：`盘符:` 粗体 + 反斜杠路径，等宽；过长时中段省略（`…\生产\卡套`）且 `title` 给全路径。

### 7.4 动效
只允许：hover/press 120–160ms；面板展开 160–240ms；监听点呼吸 2.4s（`pulse`）；toast 进场 160ms。全部走 `--dur-*` 与 `--ease-*`，并遵守 `prefers-reduced-motion`。

---

## 8. 响应式断点与 1366×768 折叠策略

| 断点 | 行为 |
| --- | --- |
| **≥1920×1080** | 内容区 `max-width: 1440px` 居中；卡片间距 20；表格行高 52；允许记录页显示 10 列全部 + 「回信状态」列 |
| **1440×900（基准）** | 本稿即此尺寸：窗口 1408×868，无滚动 |
| **1366×768（客户机）** | 见下折叠表；**整页仍不出现横向滚动** |
| **1280×800（最小可用）** | 侧栏收窄到 200px（仅图标 + 当前项显示文字）；页面标题 24；卡片 gap 12 |
| < 1280 | 不作为桌面目标；若窗口被缩放，内容区出现纵向滚动，侧栏转图标条 |

**1366×768 折叠优先级**（按“先砍什么”排序）：
1. `04 自动回复`：隐藏右侧预览的「引用原文」块，预览改 50/50 宽 → 保留模板与变量。
2. `05 记录`：隐藏「账户」列与「操作」列文字（只留图标）；行高 44。
3. `03 规则`：左栏 340 → 292；`04 本规则最近命中` 折叠为一行摘要（「最近 3 次命中 · 查看 ›」）。
4. `01 概览`：三卡改 2 列（邮箱 + 盘合并为一张），最近收件显示 4 行。
5. `06 组件`：仅作用于设计评审，实现时不做响应式。

**必须保留（任何尺寸都不折叠）**：存储路径与被编辑路径的完整可见性、状态徽章、失败重试入口、监听状态与邮箱连接状态。

---

## 9. 偏差与待拍板（会影响开发）

| # | 项 | 本稿做法 | 需要谁决定 |
| --- | --- | --- | --- |
| D1 | 账户「已启用」文案 | 用「已启用」（比「正常监听」更懂 IMAP/SMTP 语境，且不暗示「授权」） | Lead：确认与 §5.1 新枚举一致后写进 `enums.ts` |
| D2 | 邮件 `failed` 的用户文案 | 用「待重试」而非「失败」（避免操作员恐慌），`failed` 仅在重试耗尽后显示「失败 · 需人工处理」 | 同上 |
| D3 | 部分成功徽章 | 05 用「部分完成」（amber） | 同上 |
| D4 | 回信语言 | 默认 **English**（客户在国外），UI 提供 中文/English/中英双语 | 客户（REQUIREMENTS §9 Q8） |
| D5 | 变量集合 | 只用 4 个：`{关键词}{文件名}{数量}{时间}` | 客户确认是否需要 `{发件人}`/`{公司}` |
| D6 | 未命中是否留痕 | 05 有「已忽略」状态与筛选 → 默认**留痕** | 客户（§9 Q2） |
| D7 | 一封邮件命中多条规则 | 03 显示「按优先级从上到下执行」，未画「只执行最高优先级」开关 | 客户（§9 Q5） |
| D8 | 删除规则 | 模态给三选项：取消 / 停用而不删除 / 确认删除（推荐停用） | Lead 确认交互是否过重 |
| D9 | 单路径重试 | 行内直接重试，不弹确认；结果用 toast 反馈 | 是否要「重试前选路径」 |
| D10 | 托盘菜单项 | 打开主界面 / 暂停监听 / 打开存储文件夹 / 开机自启 / 退出 | 是否加「立即检查新邮件」 |
| D11 | 出厂预设 3 条规则 | 3 条预设 + 3 条后加（含停用）；「导入预设 3 条」在 06 空态 | 客户确认关键词文案（`原图+手机壳` 是否带空格） |
| D12 | 工厂署名 | 回信用占位 `Haiyin POD · Prepress / 海印 POD 定制工厂` | 客户提供真实英文署名 |
| **D13** | **IMAP/SMTP 端口与加密默认** | Gmail：993/465 + SSL；QQ：993/465 + SSL；Outlook：993/587 + STARTTLS（预设里默认值见 README §3.2） | 客户 IT 环境若封端口，是否要「自动降级 STARTTLS」开关（建议要） |
| **D14** | **密码存储** | 图里写「DPAPI 加密、只存本机」。IMAP/SMTP 是**可逆密码**（不是 token），必须真正加密且日志脱敏 | Lead 确认 `safeStorage`/DPAPI 方案后再定「导出配置」是否含密码（建议不含，导入后重填） |
| **D15** | **Gmail 应用专用密码前提** | 文案已写明需先开两步验证。若客户账号是企业 Workspace 且被管理员禁用应用专用密码，则只能用 OAuth（客户已明确不要）→ 需 IT 放开或换 SMTP 中继 | 客户（附录 A1 已提示账号类型风险） |
| **D16** | **测试连接的判定** | IMAP 测「登录 + 选收件箱」；SMTP 测「登录 + NOOP/握手」，不真的发信（避免脏数据） | Lead 确认是否要「发一封测试信」独立按钮 |

## 10. 交付自查

- [x] 6 张 1440×900 高保真图，主要信息**一屏不滚动**（已用 `render.py` 逐屏截图复核，无裁切）。
- [x] 全中文界面（英文仅作副标题/业务名词/回信正文），无 Lorem ipsum。
- [x] P0 状态 + 关键词列表空状态均有图（见 §4.1），其中「邮箱需重新授权」已按 v0.3 改为「邮箱连接失败 · 密码错误」。
- [x] 存储路径在 03 处处可见、可编辑、可打开、可增删；一条规则多路径的「扇出」表达一致。
- [x] 邮箱不写死：多账户 + IMAP/SMTP 手填 + 5 种服务商预设 + 分别测试连接 + 启停/编辑/删除。
- [x] 数字/时间/大小/路径全部等宽对齐，时间统一 `2026-11-22 15:44`。
- [x] 无紫色渐变 / 玻璃拟态 / 3D 图标 / emoji 图标；图标均为内联 SVG。
- [x] `tokens.css` 单文件纯变量，六屏与组件页引用同一套令牌。
- [x] 每屏 hover / active / focus / disabled 状态与键盘焦点环已定义（06 集中展示）。
