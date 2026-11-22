# Windows 安装包：构建、验证与交付说明

> 当前产物：`release/MailHarbor-Setup-0.1.0.exe`（117 MB，NSIS，x64，按用户安装、免管理员）
> 构建机：macOS（交叉打包）· Electron 45.4.1 · 未签名（首次运行会有 SmartScreen 提示）

---

## 1. 为什么能在 macOS 上打出 Windows 包

| 常规坑 | 本项目的处理 |
| --- | --- |
| `better-sqlite3` 是原生模块，跨平台必须重编译 | **改为可选的开发期依赖**，运行时自动回退到 Electron 内置的 `node:sqlite`（`src/main/sqlite.ts` 适配层）。安装包里不含 `.node`，不挑平台、不需要 MSVC |
| `rcedit` 改 exe 图标/版本信息需要 wine | `win.signAndEditExecutable: false` 跳过；图标通过 NSIS 安装包与快捷方式呈现 |
| Electron 二进制下载被墙 | `electronDownload.mirror` 指向 npmmirror |
| NSIS 工具链下载被墙 | 构建时设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` |

## 2. 重新构建

```bash
# 一次性环境
npx pnpm install
npx electron-vite build

# 打安装包（约 2–4 分钟，首次会下载 Electron win32 运行时与 NSIS）
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win nsis --x64

# 只出免安装目录（调试用）
npx electron-builder --win --x64 --dir
```

产物：

```
release/
├── MailHarbor-Setup-0.1.0.exe          # 安装包（发给客户）
├── MailHarbor-Setup-0.1.0.exe.blockmap # 差量升级用
└── win-unpacked/                       # 免安装绿色版（可直接 zip 发）
```

## 3. 安装包做了什么

| 项 | 行为 |
| --- | --- |
| 安装位置 | `%LOCALAPPDATA%\Programs\MailHarbor`（按用户安装，**不需要管理员/UAC**） |
| 快捷方式 | 桌面 + 开始菜单「MailHarbor」 |
| 卸载 | 控制面板卸载；**保留** `%APPDATA%\MailHarbor`（数据库/日志/凭证），换机不丢历史 |
| 开机自启 | 软件内设置页开关（写 HKCU Run），带 `--autostart` 参数时静默进托盘 |
| 单实例 | 重复启动会聚焦已有窗口，不会双开收信 |
| 首次运行 | 不弹 UAC；首次会创建数据库与临时目录 |

## 4. 验证结果（打包运行时）

因为 macOS 跑不了 exe，我用**与 Windows 包完全相同的运行时路径**做了验证：
用打包后的 Electron 二进制启动应用，并强制 `MH_FORCE_NODE_SQLITE=1`（等价于 Windows 包内没有 `better-sqlite3` 的情况）。

`scripts/packaged-e2e.mjs`（16 项断言全过）：

```
✓ 账户已创建 / 测试后状态=已启用
✓ IMAP 测试通过 / SMTP 测试通过
✓ 规则两个目标路径
✓ 生产目录有文件 / 备份目录有文件 / 文件名一致
✓ 附件内容确为 ZIP（PK 头）
✓ SMTP 收到回信 / 回信含文件名
✓ 记录写入 / 命中行 done / 两条投递都 done / 回信状态 sent
```

另外静态核对了 `app.asar`：包含 `out/main`、`out/preload`、`out/renderer`，且**不含** `better-sqlite3`（证实走的是 `node:sqlite`）。

**仍需在真 Windows 上做的 3 件事**（我这边没有 Windows 机器）：

1. 双击安装 → 桌面快捷方式 → 首次启动是否正常、有无 SmartScreen 拦截（预计有，未签名）。
2. 设置页打开「开机自启」→ 重启电脑 → 确认托盘常驻、无窗口弹出。
3. 用真实 Gmail/QQ 的应用专用密码跑一次收发（界面里「测试连接」即可）。

## 5. 签名（重要，但不阻塞试用）

未签名的 exe 首次运行会弹：

> Windows 已保护你的电脑 · 未知发布者

**必做**：买 OV/EV 代码签名证书后重新打包，并提交 [Microsoft WDSI](https://www.microsoft.com/en-us/wdsi/filesubmission) 报备。证书到手后只需：

```yaml
win:
  certificateFile: certs/mailharbor.pfx
  certificatePassword: ${env.CSC_KEY_PASSWORD}
  signingHashAlgorithms: [sha256]
  signAndEditExecutable: true     # 有 wine/Windows 构建机时打开，顺便写 exe 图标
```

> 建议最终在 **Windows 构建机或 GitHub Actions（windows-latest）** 上出正式包，macOS 交叉打包适合快速验证与内测分发。

## 6. 交付给客户的文件清单

1. `MailHarbor-Setup-0.1.0.exe` — 双击安装
2. `MailHarbor-使用说明.pdf` / 本仓库 `design/index.html` — 界面与操作说明
3. 邮箱准备说明：Gmail 需先开两步验证 → 生成 16 位应用专用密码；QQ 邮箱设置里生成授权码
4. 首次配置：打开软件 → 邮箱账户 → 选预设 → 填账号 + 应用专用密码 → 测试连接（应双绿）→ 保存并启用 → 触发规则里加关键词与目标文件夹

## 7. 升级与回滚

- 现在**没有接自动更新**（`electron-updater` 未启用）。发新版本 = 重新发安装包，覆盖安装即可，数据库与配置保留。
- 需要自动更新时，接 `electron-updater` + 一个静态文件服务器（S3/OSS 即可），配置 `publish` 后用 `--publish always` 上传，客户端每天检查一次。
- 回滚：安装上一版本的 exe 覆盖即可（数据库 schema 目前 v1，未做向下兼容，改动 schema 时先备份 `%APPDATA%\MailHarbor\mailharbor.db`）。
