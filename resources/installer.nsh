; 额外保证：
;  1) 桌面一定生成「邮箱资料助手」快捷方式（带图标）
;  2) 开始菜单同样有入口
;  3) 卸载时清理桌面快捷方式
; 说明：electron-builder 的 createDesktopShortcut 偶发在中文产品名/OneDrive 桌面重定向下失效，
;       这里用 NSIS 原生 CreateShortCut 兜底，路径固定写到当前用户的桌面。

!macro customInstall
  ; 桌面快捷方式
  CreateShortCut "$DESKTOP\邮箱资料助手.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "邮箱资料助手 · 客户邮件自动归档"
  ; 开始菜单快捷方式（目录可能已由 electron-builder 创建）
  CreateDirectory "$SMPROGRAMS\邮箱资料助手"
  CreateShortCut "$SMPROGRAMS\邮箱资料助手\邮箱资料助手.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "邮箱资料助手 · 客户邮件自动归档"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\邮箱资料助手.lnk"
  Delete "$SMPROGRAMS\邮箱资料助手\邮箱资料助手.lnk"
  RMDir "$SMPROGRAMS\邮箱资料助手"
!macroend
