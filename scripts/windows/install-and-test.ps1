# MailHarbor Windows 装机脚本：静默安装 → 自检 → 启动
# 在 Windows 里右键「使用 PowerShell 运行」，或者：
#   powershell -ExecutionPolicy Bypass -File install-and-test.ps1
param(
  [string]$Installer = "",
  [switch]$NoInstall,
  [switch]$StartApp
)

$ErrorActionPreference = "Stop"
$out = Join-Path $env:USERPROFILE "Desktop\邮箱资料助手-测试结果.txt"
function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $out -Value $line -Encoding UTF8
}

Log "===== 邮箱资料助手 装机自检 ====="
Log ("系统: {0} / {1}" -f (Get-CimInstance Win32_OperatingSystem).Caption, $env:PROCESSOR_ARCHITECTURE)

# 1) 找安装包
if (-not $NoInstall) {
  if (-not $Installer) {
    $candidates = @(
      (Join-Path $PSScriptRoot "MailHarbor-Setup-*.exe"),
      (Join-Path $env:USERPROFILE "Downloads\MailHarbor-Setup-*.exe"),
      (Join-Path $PSScriptRoot "..\..\release\MailHarbor-Setup-*.exe")
    )
    foreach ($c in $candidates) {
      $f = Get-ChildItem $c -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
      if ($f) { $Installer = $f.FullName; break }
    }
  }
  if (-not $Installer -or -not (Test-Path $Installer)) {
    Log "找不到安装包 MailHarbor-Setup-*.exe，请把安装包放到本脚本同目录后重试"
    exit 1
  }
  Log ("安装包: {0}" -f $Installer)
  Log "开始静默安装（按用户安装，不需要管理员）…"
  $p = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
  Log ("安装进程退出码: {0}" -f $p.ExitCode)
  Start-Sleep -Seconds 3
}

# 2) 找主程序
$names = @("邮箱资料助手", "MailHarbor")
$exe = $null
foreach ($n in $names) {
  $candidate = Join-Path $env:LOCALAPPDATA "Programs\$n\$n.exe"
  if (Test-Path $candidate) { $exe = $candidate; break }
}
if (-not $exe) {
  Log "未找到主程序（已找：$($names -join ', ')），安装可能失败"
  exit 1
}
Log ("主程序: {0} (v{1})" -f $exe, (Get-Item $exe).VersionInfo.FileVersion)

# 3) 自检：写 JSON 报告（不需要界面，2 分钟内返回）
$report = Join-Path $env:TEMP "mailharbor-selfcheck.json"
Remove-Item $report -ErrorAction SilentlyContinue
Log "运行 --self-check …"
$proc = Start-Process -FilePath $exe -ArgumentList "--self-check", "`"$report`"" -PassThru
if (-not $proc.WaitForExit(120000)) { try { $proc.Kill() } catch {} ; Log "自检超时" }
Start-Sleep -Seconds 2

if (Test-Path $report) {
  $json = Get-Content $report -Raw | ConvertFrom-Json
  Log ("自检结果: ok={0} 版本={1} 平台={2}/{3}" -f $json.ok, $json.version, $json.platform, $json.arch)
  Log ("数据目录: {0}" -f $json.userData)
  Log ("数据库: {0}" -f $json.dbPath)
  Log ("代理模式: {0}" -f $json.proxy.mode)
  Log ("预置规则 {0} 条:" -f $json.rules.Count)
  foreach ($r in $json.rules) {
    Log ("  · {0} → {1}" -f $r.keyword, ($r.paths -join " ; "))
  }
  Log ("已配置邮箱: {0} 个" -f $json.accounts.Count)
} else {
  Log "自检报告未生成（应用可能启动失败），请查看 %APPDATA%\MailHarbor 目录"
}

# 4) 启动界面
$running = Get-Process -Name "邮箱资料助手","MailHarbor" -ErrorAction SilentlyContinue
if ($StartApp -and -not $running) {
  Log "启动 邮箱资料助手 界面…"
  Start-Process -FilePath $exe | Out-Null
  Start-Sleep -Seconds 6
}
$running = Get-Process -Name "邮箱资料助手","MailHarbor" -ErrorAction SilentlyContinue
if ($running) {
  Log "进程状态: 运行中（PID $($running[0].Id)）"
} else {
  Log "进程状态: 未运行（若是自检后正常退出，属正常）"
}

Log "===== 完成，结果已保存到桌面 邮箱资料助手-测试结果.txt ====="
Write-Host ""
Write-Host "下一步：打开 邮箱资料助手 → 邮箱账户 → 填 Gmail 应用专用密码 / QQ 授权码 → 测试连接 → 保存并启用" -ForegroundColor Cyan
