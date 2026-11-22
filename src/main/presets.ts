/** 服务商预设：选好预设自动填 IMAP / SMTP 主机端口加密方式 */
import type { AccountInput, ProviderPreset } from '@shared/types'

export interface PresetDef {
  id: ProviderPreset
  label: string
  imapHost: string
  imapPort: number
  imapSecure: 'ssl' | 'starttls' | 'none'
  smtpHost: string
  smtpPort: number
  smtpSecure: 'ssl' | 'starttls' | 'none'
  passwordHint: string
  supported: boolean
  unsupportedReason?: string
}

export const PRESETS: PresetDef[] = [
  {
    id: 'gmail', label: 'Gmail',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl',
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl',
    passwordHint: 'Gmail 请填「应用专用密码」（16 位，需先开启两步验证），不是邮箱登录密码',
    supported: true
  },
  {
    id: 'google_workspace', label: 'Google Workspace',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl',
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl',
    passwordHint: 'Workspace 账号同样使用应用专用密码；若管理员禁用了 IMAP，需要联系管理员开启',
    supported: true
  },
  {
    id: 'qq', label: 'QQ 邮箱',
    imapHost: 'imap.qq.com', imapPort: 993, imapSecure: 'ssl',
    smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: 'ssl',
    passwordHint: 'QQ 请填「授权码」：邮箱设置 → 账户 → 开启 IMAP/SMTP 服务 → 短信验证后得到 16 位授权码',
    supported: true
  },
  {
    id: 'outlook', label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: 'ssl',
    smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: 'starttls',
    passwordHint: '微软已停用 IMAP/SMTP 基本认证，此预设通常无法登录；建议改用 Gmail 或 QQ 邮箱',
    supported: false,
    unsupportedReason: '微软已停用应用专用密码方式，当前版本不支持 Outlook 收信'
  },
  {
    id: 'custom', label: '自定义',
    imapHost: '', imapPort: 993, imapSecure: 'ssl',
    smtpHost: '', smtpPort: 465, smtpSecure: 'ssl',
    passwordHint: '填写企业邮箱提供的 IMAP / SMTP 服务器地址与密码或授权码',
    supported: true
  }
]

export function presetById(id: ProviderPreset): PresetDef {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1]
}

/** 用预设补全一个空表单 */
export function emptyAccountInput(preset: ProviderPreset = 'gmail'): AccountInput {
  const p = presetById(preset)
  return {
    preset,
    email: '',
    displayName: '',
    imapHost: p.imapHost,
    imapPort: p.imapPort,
    imapSecure: p.imapSecure,
    imapUser: '',
    smtpHost: p.smtpHost,
    smtpPort: p.smtpPort,
    smtpSecure: p.smtpSecure,
    smtpUser: '',
    smtpFromName: 'MailHarbor 收货助手',
    smtpSameAsImap: true,
    password: '',
    smtpPassword: ''
  }
}
