/** 状态枚举 → 中文文案 / 徽章配色 的唯一映射（页面不要各自写颜色） */
import type {
  AccountStatus, DeliveryState, Encryption, MatchMode, MatchScope, MessageStatus, ProviderPreset,
  ReplyStatus, TargetHealth
} from '@shared/types'
import type { IconName } from '../components/Icon'

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'accent' | 'outline'

export interface BadgeMeta {
  tone: BadgeTone
  label: string
  icon?: IconName
  spinner?: boolean
  dot?: boolean
}

/** 账户状态（§5.1 六态） */
export function accountStatusMeta(s: AccountStatus): BadgeMeta {
  switch (s) {
    case 'enabled':
      return { tone: 'ok', label: '已启用', dot: true }
    case 'pending_test':
      return { tone: 'outline', label: '待测试' }
    case 'auth_failed':
      return { tone: 'bad', label: '连接失败', icon: 'alert' }
    case 'conn_failed':
      return { tone: 'bad', label: '连接失败', icon: 'alert' }
    case 'offline':
      return { tone: 'warn', label: '网络离线', dot: true }
    case 'disabled':
    default:
      return { tone: 'neutral', label: '未启用' }
  }
}

/** 邮件聚合状态（§5.2 六态） */
export function messageStatusMeta(s: MessageStatus): BadgeMeta {
  switch (s) {
    case 'queued':
      return { tone: 'info', label: '处理中', spinner: true }
    case 'partial':
      return { tone: 'warn', label: '部分完成' }
    case 'done':
      return { tone: 'ok', label: '已归档' }
    case 'failed':
      return { tone: 'bad', label: '待重试' }
    case 'ignored_type':
      return { tone: 'neutral', label: '类型不符' }
    case 'ignored_no_keyword':
    default:
      return { tone: 'neutral', label: '已忽略' }
  }
}

/** 回信状态（§5.4 五态） */
export function replyStatusMeta(s: ReplyStatus): BadgeMeta {
  switch (s) {
    case 'sent':
      return { tone: 'ok', label: '已回信' }
    case 'pending':
      return { tone: 'info', label: '等待中' }
    case 'failed':
      return { tone: 'bad', label: '回信失败' }
    case 'suppressed':
      return { tone: 'neutral', label: '已抑制' }
    case 'disabled':
    default:
      return { tone: 'neutral', label: '回信已关闭' }
  }
}

export type ChipTone = 'pending' | 'copy' | 'ok' | 'retry' | 'bad' | 'skip'

export interface DeliveryMeta {
  chip: ChipTone
  label: string
  icon?: IconName
  spinner?: boolean
}

/** 单条路径投递状态（§5.3 六态） */
export function deliveryMeta(s: DeliveryState): DeliveryMeta {
  switch (s) {
    case 'done':
      return { chip: 'ok', label: '已写入', icon: 'check' }
    case 'copying':
      return { chip: 'copy', label: '复制中', icon: 'clock', spinner: true }
    case 'retry_wait':
      return { chip: 'retry', label: '等待重试', icon: 'alert' }
    case 'failed':
      return { chip: 'bad', label: '重试失败', icon: 'x' }
    case 'skipped':
      return { chip: 'skip', label: '已跳过' }
    case 'pending':
    default:
      return { chip: 'pending', label: '排队中', icon: 'clock' }
  }
}

/** 路径可用性（§5.5 四态） */
export function targetHealthMeta(h: TargetHealth | null | undefined): BadgeMeta & { text: string } {
  switch (h) {
    case 'ok':
      return { tone: 'ok', label: '正常', text: '路径可用' }
    case 'low_space':
      return { tone: 'warn', label: '空间不足', text: '剩余空间不足' }
    case 'unavailable':
      return { tone: 'bad', label: '不可用', text: '磁盘未连接 · 路径不可用' }
    case 'unknown':
    default:
      return { tone: 'outline', label: '未检测', text: '尚未检测路径' }
  }
}

export function providerLabel(p: ProviderPreset): string {
  switch (p) {
    case 'gmail':
      return 'Gmail'
    case 'google_workspace':
      return 'Google Workspace'
    case 'qq':
      return 'QQ 邮箱'
    case 'outlook':
      return 'Outlook / Microsoft 365'
    case 'custom':
    default:
      return '自定义'
  }
}

export function encryptionLabel(e: Encryption): string {
  switch (e) {
    case 'ssl':
      return 'SSL/TLS'
    case 'starttls':
      return 'STARTTLS'
    case 'none':
    default:
      return '不加密'
  }
}

export function scopeLabel(s: MatchScope): string {
  return s === 'subject' ? '仅标题' : '标题+正文'
}

export function modeLabel(m: MatchMode): string {
  return m === 'exact' ? '精确' : '包含'
}

export function replyLanguageLabel(l: 'zh' | 'en' | 'both'): string {
  return l === 'zh' ? '中文' : l === 'en' ? 'English' : '中英双语'
}

export function accountTypeLabel(status: AccountStatus): string {
  switch (status) {
    case 'enabled':
      return '在用'
    case 'disabled':
      return '已停用'
    case 'auth_failed':
    case 'conn_failed':
      return '连接失败'
    case 'offline':
      return '离线'
    case 'pending_test':
    default:
      return '待测试'
  }
}
