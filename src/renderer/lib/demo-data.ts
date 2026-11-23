/**
 * 浏览器 / 无 preload 环境下的演示数据（纯内存，字段严格对齐 src/shared/types.ts）。
 * 真实 Electron 环境始终走 window.mailharbor，不会用到本文件。
 */
import type {
  Account, DashboardData, Delivery, DeliveryState, DiskInfo, RecordRow, Rule, RuleTarget, Settings,
  TestResult, TestResultLine
} from '@shared/types'

const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const ago = (ms: number): number => NOW - ms

function diskPath(drive: 'D' | 'E' | 'F'): string {
  return `${drive}:\\POD\\${drive === 'D' ? '生产' : drive === 'E' ? '备份' : '归档'}\\卡套`
}

// ---------------------------------------------------------------------------
// 账户（覆盖 启用 / 连接失败 / 待测试 / 已停用 四态）
// ---------------------------------------------------------------------------
export const DEMO_ACCOUNTS: Account[] = [
  {
    id: 1,
    preset: 'gmail',
    email: 'bin.pod.print@gmail.com',
    displayName: '主账号',
    status: 'enabled',
    enabled: true,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: 'ssl',
    imapUser: 'bin.pod.print@gmail.com',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: 'ssl',
    smtpUser: 'bin.pod.print@gmail.com',
    smtpFromName: 'Haiyin POD · Prepress',
    smtpSameAsImap: true,
    allowSelfSigned: false,
    sendOnly: false,
    hasPassword: true,
    lastCheckAt: ago(2 * MIN),
    lastOkAt: ago(2 * MIN),
    lastErrorCode: null,
    lastError: null,
    lastUid: 20486,
    uidValidity: '18446744073709551615',
    todayCount: 14,
    totalFiles: 2847,
    createdAt: ago(20 * DAY),
    updatedAt: ago(2 * MIN)
  },
  {
    id: 2,
    preset: 'gmail',
    email: 'orders.haiyin.pod@gmail.com',
    displayName: '备账号',
    status: 'auth_failed',
    enabled: true,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: 'ssl',
    imapUser: 'orders.haiyin.pod@gmail.com',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: 'ssl',
    smtpUser: 'orders.haiyin.pod@gmail.com',
    smtpFromName: 'Haiyin POD · Prepress',
    smtpSameAsImap: true,
    allowSelfSigned: false,
    sendOnly: false,
    hasPassword: true,
    lastCheckAt: ago(2 * HOUR),
    lastOkAt: ago(2 * HOUR + 10 * MIN),
    lastErrorCode: '535',
    lastError: 'IMAP 登录被拒绝（535）：用户名或密码不正确',
    lastUid: 1108,
    uidValidity: '16238291',
    todayCount: 0,
    totalFiles: 312,
    createdAt: ago(13 * DAY),
    updatedAt: ago(2 * HOUR)
  },
  {
    id: 3,
    preset: 'custom',
    email: 'studio.haiyin@printmail.cn',
    displayName: '新账号',
    status: 'pending_test',
    enabled: false,
    imapHost: 'imap.printmail.cn',
    imapPort: 993,
    imapSecure: 'ssl',
    imapUser: 'studio.haiyin@printmail.cn',
    smtpHost: 'smtp.printmail.cn',
    smtpPort: 465,
    smtpSecure: 'ssl',
    smtpUser: 'studio.haiyin@printmail.cn',
    smtpFromName: 'Haiyin POD · Prepress',
    smtpSameAsImap: true,
    allowSelfSigned: false,
    sendOnly: false,
    hasPassword: false,
    lastCheckAt: null,
    lastOkAt: null,
    lastErrorCode: null,
    lastError: null,
    lastUid: 0,
    uidValidity: null,
    todayCount: 0,
    totalFiles: 0,
    createdAt: ago(4 * HOUR),
    updatedAt: ago(4 * HOUR)
  },
  {
    id: 4,
    preset: 'gmail',
    email: 'backup.print.hk@gmail.com',
    displayName: '备用账号',
    status: 'disabled',
    enabled: false,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: 'ssl',
    imapUser: 'backup.print.hk@gmail.com',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: 'ssl',
    smtpUser: 'backup.print.hk@gmail.com',
    smtpFromName: 'Haiyin POD · Prepress',
    smtpSameAsImap: true,
    allowSelfSigned: false,
    sendOnly: false,
    hasPassword: true,
    lastCheckAt: ago(4 * DAY),
    lastOkAt: ago(4 * DAY),
    lastErrorCode: null,
    lastError: null,
    lastUid: 641,
    uidValidity: '99213',
    todayCount: 0,
    totalFiles: 641,
    createdAt: ago(40 * DAY),
    updatedAt: ago(4 * DAY)
  }
]

// ---------------------------------------------------------------------------
// 规则（6 条：4 启用 / 2 停用；一条多路径，含空间不足与路径不可用）
// ---------------------------------------------------------------------------
const FILE_TYPES = ['zip', 'rar', 'tif', 'tiff', 'jpg', 'png', 'pdf']

function target(
  id: number,
  ruleId: number,
  path: string,
  required: boolean,
  sortOrder: number,
  health: RuleTarget['lastHealth'],
  freeBytes: number | null,
  totalBytes: number | null
): RuleTarget {
  return { id, ruleId, path, required, sortOrder, enabled: true, lastHealth: health, freeBytes, totalBytes }
}

const GB = 1024 ** 3

export const DEMO_RULES: Rule[] = [
  {
    id: 1,
    keyword: '原图+手机壳',
    enabled: true,
    scope: 'subject',
    mode: 'exact',
    priority: 1,
    fileTypes: FILE_TYPES,
    autoReply: true,
    hitMessages: 248,
    hitFiles: 372,
    lastHitAt: ago(8 * MIN),
    targets: [
      target(101, 1, 'D:\\POD\\生产\\手机壳', true, 0, 'ok', 178 * GB, 512 * GB),
      target(102, 1, 'E:\\POD\\备份\\手机壳', true, 1, 'ok', 46 * GB, 1024 * GB)
    ],
    createdAt: ago(60 * DAY),
    updatedAt: ago(3 * DAY)
  },
  {
    id: 2,
    keyword: '原图+卡套',
    enabled: true,
    scope: 'subject',
    mode: 'exact',
    priority: 2,
    fileTypes: FILE_TYPES,
    autoReply: true,
    hitMessages: 132,
    hitFiles: 508,
    lastHitAt: ago(2 * MIN),
    targets: [
      target(103, 2, 'D:\\POD\\生产\\卡套', true, 0, 'ok', 178 * GB, 512 * GB),
      target(104, 2, 'E:\\POD\\备份\\卡套', true, 1, 'low_space', 46 * GB, 1024 * GB),
      target(105, 2, 'F:\\POD\\归档\\卡套', false, 2, 'unavailable', null, null)
    ],
    createdAt: ago(58 * DAY),
    updatedAt: ago(2 * MIN)
  },
  {
    id: 3,
    keyword: '原图+浴室垫',
    enabled: true,
    scope: 'subject',
    mode: 'contains',
    priority: 3,
    fileTypes: FILE_TYPES,
    autoReply: true,
    hitMessages: 87,
    hitFiles: 104,
    lastHitAt: ago(15 * MIN),
    targets: [target(106, 3, 'D:\\POD\\生产\\浴室垫', true, 0, 'ok', 178 * GB, 512 * GB)],
    createdAt: ago(45 * DAY),
    updatedAt: ago(5 * DAY)
  },
  {
    id: 4,
    keyword: '原图+卫衣',
    enabled: true,
    scope: 'subject',
    mode: 'contains',
    priority: 4,
    fileTypes: ['zip', 'tif', 'pdf'],
    autoReply: true,
    hitMessages: 0,
    hitFiles: 0,
    lastHitAt: null,
    targets: [target(107, 4, 'D:\\POD\\生产\\卫衣', true, 0, 'unknown', null, null)],
    createdAt: ago(3 * DAY),
    updatedAt: ago(3 * DAY)
  },
  {
    id: 5,
    keyword: '原图+抱枕',
    enabled: false,
    scope: 'subject',
    mode: 'exact',
    priority: 5,
    fileTypes: FILE_TYPES,
    autoReply: false,
    hitMessages: 12,
    hitFiles: 12,
    lastHitAt: ago(2 * DAY),
    targets: [target(108, 5, 'D:\\POD\\生产\\抱枕', true, 0, 'ok', 178 * GB, 512 * GB)],
    createdAt: ago(30 * DAY),
    updatedAt: ago(7 * DAY)
  },
  {
    id: 6,
    keyword: '原图+鼠标垫',
    enabled: false,
    scope: 'subject',
    mode: 'contains',
    priority: 6,
    fileTypes: FILE_TYPES,
    autoReply: false,
    hitMessages: 4,
    hitFiles: 6,
    lastHitAt: ago(9 * DAY),
    targets: [
      target(109, 6, 'D:\\POD\\生产\\鼠标垫', true, 0, 'ok', 178 * GB, 512 * GB),
      target(110, 6, 'E:\\POD\\备份\\鼠标垫', false, 1, 'low_space', 46 * GB, 1024 * GB)
    ],
    createdAt: ago(25 * DAY),
    updatedAt: ago(9 * DAY)
  }
]

// ---------------------------------------------------------------------------
// 记录（含多路径结果 / 处理中 / 失败 / 忽略）
// ---------------------------------------------------------------------------
interface RecordSpec {
  subject: string
  fromAddr: string
  fromName: string
  keyword: string | null
  ruleId: number | null
  file: string
  size: number
  accountId: number
  accountEmail: string
  status: RecordRow['status']
  reply: RecordRow['replyStatus']
  drives: Array<{ drive: 'D' | 'E' | 'F'; required: boolean; state: DeliveryState }>
}

const SPECS: RecordSpec[] = [
  {
    subject: '原图+卡套 追加 2 款：POD_ORDER_20511',
    fromAddr: '',
    fromName: '',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'POD_ORDER_20511.zip',
    size: 12.6 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'queued',
    reply: 'pending',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'copying' },
      { drive: 'F', required: false, state: 'pending' }
    ]
  },
  {
    subject: '原图+卡套 追加：POD_ORDER_20486',
    fromAddr: 'david@inkpressed.co',
    fromName: 'David Chen',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'POD_ORDER_20486.zip',
    size: 18.4 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'partial',
    reply: 'pending',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' },
      { drive: 'F', required: false, state: 'failed' }
    ]
  },
  {
    subject: '原图+手机壳 秋祭限定 12 款',
    fromAddr: 'mika@tokyoprint.jp',
    fromName: 'Mika Sato',
    keyword: '原图+手机壳',
    ruleId: 1,
    file: 'design_bundle_v3.tif',
    size: 42.1 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' }
    ]
  },
  {
    subject: '原图+浴室垫 BATH-MAT-2208',
    fromAddr: 'orders@printlab.de',
    fromName: 'Printlab Orders',
    keyword: '原图+浴室垫',
    ruleId: 3,
    file: 'BATH_MAT_2208_print.tiff',
    size: 26.7 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [{ drive: 'D', required: true, state: 'done' }]
  },
  {
    subject: '原图+卡套 打样确认',
    fromAddr: 'david@inkpressed.co',
    fromName: 'David Chen',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'sampling_proof_v2.tif',
    size: 8.8 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'partial',
    reply: 'pending',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'failed' },
      { drive: 'F', required: false, state: 'done' }
    ]
  },
  {
    subject: '原图+抱枕 PILLOW-0713',
    fromAddr: 'lena@haus-of-print.com',
    fromName: 'Lena Hoffmann',
    keyword: null,
    ruleId: null,
    file: 'pillow_0713_art.zip',
    size: 22.4 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'ignored_no_keyword',
    reply: 'disabled',
    drives: []
  },
  {
    subject: '原图+手机壳 补发 3 款',
    fromAddr: 'kevin@casecraft.io',
    fromName: 'Kevin Wu',
    keyword: '原图+手机壳',
    ruleId: 1,
    file: 'phonecase_fix_v2.zip',
    size: 12.5 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' }
    ]
  },
  {
    subject: 'RE: 原图+卡套 数量确认',
    fromAddr: 'mika@tokyoprint.jp',
    fromName: 'Mika Sato',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'order_qty_sheet.pdf',
    size: 1.2 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'suppressed',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' },
      { drive: 'F', required: false, state: 'done' }
    ]
  },
  {
    subject: '原图+卡套 收尾：POD_FINAL_1108',
    fromAddr: 'david@inkpressed.co',
    fromName: 'David Chen',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'POD_FINAL_1108.zip',
    size: 9.7 * 1024 * 1024,
    accountId: 4,
    accountEmail: 'backup.print.hk@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' },
      { drive: 'F', required: false, state: 'done' }
    ]
  }
]

let deliverySeq = 9000

function makeDeliveries(spec: RecordSpec, messageId: number, attachmentId: number, file: string, size: number): Delivery[] {
  return spec.drives.map((d, i) => {
    deliverySeq += 1
    const path = diskPath(d.drive)
    const failed = d.state === 'failed'
    return {
      id: deliverySeq,
      messageId,
      attachmentId,
      targetId: 100 + i + 1,
      targetPath: path,
      required: d.required,
      state: d.state,
      attempts: d.state === 'failed' ? 3 : d.state === 'retry_wait' ? 1 : 1,
      nextRetryAt: d.state === 'failed' || d.state === 'retry_wait' ? NOW + 60_000 : null,
      savedPath: d.state === 'done' ? `${path}\\${file}` : null,
      savedName: d.state === 'done' ? file : null,
      size: d.state === 'done' ? size : null,
      errorCode: failed ? (d.drive === 'F' ? 'E_DISK_OFFLINE' : d.drive === 'E' ? 'E_LOW_SPACE' : 'E_WRITE') : null,
      error: failed
        ? d.drive === 'F'
          ? 'F 盘未连接 · 路径不可用（已重试 3 次）'
          : d.drive === 'E'
            ? 'E 盘剩余空间不足（低于 2 GB）'
            : '写入失败：目标文件夹无权限'
        : null,
      finishedAt: d.state === 'done' ? NOW - 2 * MIN : failed ? NOW - 5 * MIN : null
    }
  })
}

function buildRecord(spec: RecordSpec, id: number, receivedAt: number): RecordRow {
  const attachmentId = id * 10 + 1
  const deliveries = makeDeliveries(spec, id, attachmentId, spec.file, spec.size)
  const attachment = {
    id: attachmentId,
    filename: spec.file,
    size: spec.size,
    state: (spec.status === 'queued' ? 'downloaded' : 'downloaded') as 'downloaded',
    deliveries
  }
  return {
    id,
    accountId: spec.accountId,
    accountEmail: spec.accountEmail,
    subject: spec.subject,
    fromAddr: spec.fromAddr,
    fromName: spec.fromName,
    receivedAt,
    matchedKeyword: spec.keyword,
    matchedRuleId: spec.ruleId,
    status: spec.status,
    replyStatus: spec.reply,
    error: null,
    links: [],
    attachments: [attachment]
  }
}

const EXTRA_SUBJECTS: RecordSpec[] = [
  {
    subject: '原图+卡套 新单：POD_ORDER_20492',
    fromAddr: 'david@inkpressed.co',
    fromName: 'David Chen',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'POD_ORDER_20492.zip',
    size: 21.3 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' },
      { drive: 'F', required: false, state: 'done' }
    ]
  },
  {
    subject: '原图+手机壳 春季款 8 张',
    fromAddr: 'kevin@casecraft.io',
    fromName: 'Kevin Wu',
    keyword: '原图+手机壳',
    ruleId: 1,
    file: 'spring_case_pack.zip',
    size: 34.8 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' }
    ]
  },
  {
    subject: '原图+浴室垫 补图 mat_02',
    fromAddr: 'orders@printlab.de',
    fromName: 'Printlab Orders',
    keyword: '原图+浴室垫',
    ruleId: 3,
    file: 'mat_02_final.tif',
    size: 19.6 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'partial',
    reply: 'pending',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'retry_wait' }
    ]
  },
  {
    subject: 'Artwork for hoodie SS26',
    fromAddr: 'lena@haus-of-print.com',
    fromName: 'Lena Hoffmann',
    keyword: null,
    ruleId: null,
    file: 'hoodie_ss26.eps',
    size: 7.4 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'ignored_no_keyword',
    reply: 'disabled',
    drives: []
  },
  {
    subject: '原图+卡套 大货前确认',
    fromAddr: 'mika@tokyoprint.jp',
    fromName: 'Mika Sato',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'final_check_20488.zip',
    size: 15.2 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' },
      { drive: 'F', required: false, state: 'done' }
    ]
  },
  {
    subject: '原图+手机壳 样品图（2 个附件）',
    fromAddr: 'orders@printlab.de',
    fromName: 'Printlab Orders',
    keyword: '原图+手机壳',
    ruleId: 1,
    file: 'case_sample_a.tif',
    size: 11.8 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'done',
    reply: 'sent',
    drives: [
      { drive: 'D', required: true, state: 'done' },
      { drive: 'E', required: true, state: 'done' }
    ]
  },
  {
    subject: '原图+卡套 补发 2 款',
    fromAddr: 'david@inkpressed.co',
    fromName: 'David Chen',
    keyword: '原图+卡套',
    ruleId: 2,
    file: 'resend_2pcs.zip',
    size: 6.2 * 1024 * 1024,
    accountId: 1,
    accountEmail: 'bin.pod.print@gmail.com',
    status: 'partial',
    reply: 'failed',
    drives: [
      { drive: 'D', required: true, state: 'failed' },
      { drive: 'E', required: true, state: 'failed' }
    ]
  },
  {
    subject: '原图+鼠标垫 旧版重发',
    fromAddr: 'lena@haus-of-print.com',
    fromName: 'Lena Hoffmann',
    keyword: null,
    ruleId: null,
    file: 'mousepad_old.psd',
    size: 48.2 * 1024 * 1024,
    accountId: 2,
    accountEmail: 'orders.haiyin.pod@gmail.com',
    status: 'ignored_no_keyword',
    reply: 'disabled',
    drives: []
  }
]

function makeRecords(): RecordRow[] {
  const rows: RecordRow[] = []
  let id = 1
  const offsets = [0, 2, 8, 15, 34, 48, 66, 90, 170, 260, 380, 520, 700, 900, 1100, 1400, 1700, 2000]
  // 前 9 条与设计稿一致，随后按模板轮转补足记录量
  for (let i = 0; i < 64; i += 1) {
    const spec = i < SPECS.length ? SPECS[i] : EXTRA_SUBJECTS[i % EXTRA_SUBJECTS.length]
    const baseOffset = i < offsets.length ? offsets[i] * MIN : (offsets[i % offsets.length] + Math.floor(i / offsets.length) * 1440) * MIN
    const ts = ago(baseOffset + (i % 3) * 7 * MIN)
    const row = buildRecord(spec, id, ts)
    // 部分历史记录归属备账号
    if (i > 20 && i % 11 === 0) {
      row.accountId = 4
      row.accountEmail = 'backup.print.hk@gmail.com'
    }
    // 少量记录带第二个附件
    if (i > 10 && i % 13 === 0) {
      const extra = buildRecord(
        { ...spec, file: spec.file.replace(/(\.[a-z0-9]+)$/i, '_02$1') },
        id,
        ts + 1000
      )
      const att = extra.attachments[0]
      if (att) {
        att.id = id * 10 + 2
        for (const d of att.deliveries) d.attachmentId = att.id
        row.attachments.push(att)
      }
    }
    rows.push(row)
    id += 1
  }
  return rows.sort((a, b) => b.receivedAt - a.receivedAt)
}

export const DEMO_RECORDS: RecordRow[] = makeRecords()

// ---------------------------------------------------------------------------
// 设置（与 Settings 字段一一对应）
// ---------------------------------------------------------------------------
export const DEMO_SETTINGS: Settings = {
  pollIntervalSec: 30,
  proxy: { mode: 'system', host: '127.0.0.1', port: 7890 },
  replyAccountId: null,
  autostart: true,
  minimizeToTray: true,
  defaultPathEnabled: false,
  defaultPath: 'D:\\POD\\生产',
  replyEnabled: true,
  replyDelaySec: 10,
  replyThreadOnce: true,
  replyHourlyCap: 60,
  factoryName: '海印 POD · 印前组',
  replySubjectZh: '图稿已收到 — {关键词} / {文件名}',
  replyBodyZh: [
    '您好，',
    '',
    '图稿已收到，感谢！我们已按「{关键词}」归档。',
    '',
    '收到文件（{数量}）：',
    '  · {文件名}',
    '',
    '归档时间：{时间}',
    '',
    '印前组会在 24 小时内检查尺寸与色彩配置；如需重发，直接回复本邮件即可。',
    '',
    '海印 POD · 印前组'
  ].join('\n'),
  replySubjectEn: 'Artwork received — {关键词} / {文件名}',
  replyBodyEn: [
    'Hi there,',
    '',
    "Received — thanks! We've filed your artwork for {关键词}.",
    '',
    'Files received ({数量}):',
    '  · {文件名}',
    '',
    'Logged at {时间}',
    '',
    'Our prepress team will check print size and colour profile within 24 hours. If you need to resend, just reply to this email.',
    '',
    'Best regards,',
    'Haiyin POD · Prepress'
  ].join('\n'),
  replyLanguage: 'en',
  logLevel: 'info',
  retryMaxAttempts: 3,
  downloadAttempts: 3,
  downloadTimeoutSec: 900,
  extractArchives: true,
  multiRuleStrategy: 'all'
}

// ---------------------------------------------------------------------------
// 概览数据
// ---------------------------------------------------------------------------
function startOfToday(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function buildDemoDashboard(
  accounts: Account[],
  rules: Rule[],
  records: RecordRow[],
  listening: boolean,
  nextCheckAt: number | null
): DashboardData {
  const todayStart = startOfToday(NOW)
  const today = records.filter((r) => r.receivedAt >= todayStart)
  const matched = today.filter((r) => r.matchedRuleId != null)
  const files = matched.reduce((n, r) => n + r.attachments.length, 0)
  let failed = 0
  let pendingRetry = 0
  for (const r of today) {
    for (const a of r.attachments) {
      for (const d of a.deliveries) {
        if (d.state === 'failed') {
          failed += 1
          pendingRetry += 1
        } else if (d.state === 'retry_wait') {
          pendingRetry += 1
        }
      }
    }
  }
  const disks: DiskInfo[] = (
    [
      { path: 'D:\\POD\\生产', health: 'ok', freeBytes: 178 * GB, totalBytes: 512 * GB },
      { path: 'E:\\POD\\备份', health: 'low_space', freeBytes: 46 * GB, totalBytes: 1024 * GB },
      { path: 'F:\\POD\\归档', health: 'unavailable', freeBytes: null, totalBytes: null }
    ] satisfies Array<{ path: string; health: DiskInfo['health']; freeBytes: number | null; totalBytes: number | null }>
  ).map((d) => {
    const drive = d.path.slice(0, 1)
    const ruleKeywords = Array.from(
      new Set(
        rules
          .filter((r) => r.targets.some((t) => t.path.slice(0, 1).toUpperCase() === drive))
          .map((r) => r.keyword)
      )
    )
    return { ...d, ruleKeywords }
  })

  const rulePaths = rules.map((r) => ({
    ruleId: r.id,
    keyword: r.keyword,
    enabled: r.enabled,
    paths: r.targets.filter((x) => x.enabled).map((x) => ({ path: x.path, required: x.required }))
  }))

  return {
    listening,
    accounts,
    rulePaths,
    todayMessages: today.length,
    todayMatched: matched.length,
    todayFiles: files,
    todayFailed: failed,
    pendingRetry,
    disks,
    recent: records.slice(0, 6),
    pollIntervalSec: DEMO_SETTINGS.pollIntervalSec,
    nextCheckAt,
    uptimeMs: 6 * DAY + 3 * HOUR
  }
}

// ---------------------------------------------------------------------------
// 测试连接结果（演示用，与 TestResultLine 对齐）
// ---------------------------------------------------------------------------
export function demoTestResult(
  preset: 'gmail' | 'google_workspace' | 'qq' | 'outlook' | 'custom',
  imapHost: string,
  imapPort: number,
  smtpHost: string,
  smtpPort: number,
  hasCredential: boolean
): TestResult {
  const testedAt = Date.now()
  const lines: TestResultLine[] = []
  const push = (protocol: 'imap' | 'smtp', ok: boolean, latencyMs: number, host: string, port: number, errorCode?: string, message?: string): void => {
    lines.push({ protocol, ok, latencyMs, host, port, errorCode, message })
  }

  if (preset === 'outlook') {
    push('imap', false, 428, imapHost, imapPort, 'AUTH_DISABLED', '微软已停用 IMAP/SMTP 基本认证（401）')
    push('smtp', false, 391, smtpHost, smtpPort, 'AUTH_DISABLED', '微软已停用 SMTP 基本认证（401）')
    return { ok: false, lines, testedAt }
  }
  if (!imapHost || !smtpHost) {
    push('imap', false, 0, imapHost, imapPort, 'CONFIG', '请填写收发服务器地址')
    push('smtp', false, 0, smtpHost, smtpPort, 'CONFIG', '请填写收发服务器地址')
    return { ok: false, lines, testedAt }
  }
  if (!hasCredential) {
    push('imap', false, 312, imapHost, imapPort, '535', '登录被拒绝（535）：用户名或密码不正确')
    push('smtp', false, 428, smtpHost, smtpPort, '535', '登录被拒绝（535）：用户名或密码不正确')
    return { ok: false, lines, testedAt }
  }
  if (preset === 'qq' && imapPort !== 993) {
    push('imap', false, 300, imapHost, imapPort, 'TIMEOUT', 'IMAP 未开启或端口被拦截')
    push('smtp', true, 410, smtpHost, smtpPort)
    return { ok: false, lines, testedAt }
  }
  push('imap', true, 312, imapHost, imapPort)
  push('smtp', true, 428, smtpHost, smtpPort)
  return { ok: true, lines, testedAt }
}

export const DEMO_NOW = NOW
