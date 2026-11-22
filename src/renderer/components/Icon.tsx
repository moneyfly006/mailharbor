/** 内联 SVG 图标（viewBox 24 / stroke 1.6 / round caps）。路径取自设计稿，禁止 emoji 图标。 */
import type { JSX, ReactNode } from 'react'

export type IconName =
  | 'grid'
  | 'filter'
  | 'mail'
  | 'reply'
  | 'list'
  | 'sliders'
  | 'plus'
  | 'check'
  | 'x'
  | 'alert'
  | 'clock'
  | 'folder'
  | 'trash'
  | 'pencil'
  | 'copy'
  | 'grip'
  | 'search'
  | 'refresh'
  | 'pause'
  | 'play'
  | 'download'
  | 'upload'
  | 'shield'
  | 'eye'
  | 'eyeOff'
  | 'serverDown'
  | 'serverUp'
  | 'image'
  | 'send'
  | 'info'
  | 'external'
  | 'more'
  | 'minus'
  | 'chevronDown'
  | 'chevronRight'
  | 'chevronLeft'
  | 'arrowUp'
  | 'arrowDown'
  | 'file'
  | 'key'
  | 'lock'
  | 'mailCheck'

const PATHS: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
    </>
  ),
  filter: <path d="M3.5 5h17l-6.9 8.2V19l-3.6-1.9v-3.9L3.5 5z" />,
  mail: (
    <>
      <rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2" />
      <path d="M3.4 6.6l8.6 6 8.6-6" />
    </>
  ),
  mailCheck: (
    <>
      <rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2" />
      <path d="M3.4 6.6l8.6 6 8.6-6" />
      <path d="M15.4 15.4l1.6 1.6 3-3" />
    </>
  ),
  reply: (
    <>
      <path d="M9.5 6.5L4 11.5l5.5 5" />
      <path d="M4 11.5h8.6a6.4 6.4 0 016.4 6.4v.6" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </>
  ),
  sliders: (
    <>
      <path d="M6 3.5v5.5M6 15v5.5M12 3.5V9M12 15v5.5M18 3.5v8M18 17v3.5" />
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="18" cy="13.8" r="2.2" />
    </>
  ),
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  check: <path d="M4.5 12.5l4.6 4.6L19.5 6.7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: (
    <>
      <path d="M12 3.6l8.7 16.1H3.3L12 3.6z" />
      <path d="M12 9.4v4.6M12 16.8v.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7v5.3l3.4 2" />
    </>
  ),
  folder: (
    <>
      <path d="M3.2 8.4V7a1.8 1.8 0 011.8-1.8h3.8l1.9 1.9h7.5A1.8 1.8 0 0120 8.9v.9" />
      <path d="M3.2 8.4h17.5l-1.9 9.1a1.8 1.8 0 01-1.8 1.4H6.6a1.8 1.8 0 01-1.8-1.5L3.2 8.4z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9.2 7V4.8h5.6V7M6.3 7l1 13.2h9.4l1-13.2" />
      <path d="M10 10.8v6M14 10.8v6" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.2 19.9h4l10.2-10.2-4-4L4.2 15.9v4z" />
      <path d="M14.4 5.7l4 4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2" />
      <path d="M6.4 15.4H5.4a2 2 0 01-2-2V5.4a2 2 0 012-2h8a2 2 0 012 2v1" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1.3" />
      <circle cx="15" cy="6" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="9" cy="18" r="1.3" />
      <circle cx="15" cy="18" r="1.3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.2 16.2L21 21" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.6 12a7.6 7.6 0 11-2.3-5.4" />
      <path d="M19.9 4.4v5.2h-5.2" />
    </>
  ),
  pause: <path d="M9.2 5.5v13M14.8 5.5v13" />,
  play: <path d="M7.5 4.8l11 7.2-11 7.2z" fill="currentColor" stroke="none" />,
  download: (
    <>
      <path d="M12 3.8v10.4M7.8 10.4L12 14.6l4.2-4.2" />
      <path d="M4 19.2h16" />
    </>
  ),
  upload: (
    <>
      <path d="M12 20.2V9.8M7.8 13.6L12 9.4l4.2 4.2" />
      <path d="M4 4.8h16" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2l7.2 2.9v5.6c0 4.1-3 7.5-7.2 8.6-4.2-1.1-7.2-4.5-7.2-8.6V6.1L12 3.2z" />
      <path d="M9 12l2.2 2.2 4-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 12S6 5.9 12 5.9 21.6 12 21.6 12 18 18.1 12 18.1 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2.4 12S6 5.9 12 5.9 21.6 12 21.6 12 18 18.1 12 18.1 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M3.4 3.4l17.2 17.2" />
    </>
  ),
  serverDown: (
    <>
      <path d="M12 3.8v10.4M7.8 10.4L12 14.6l4.2-4.2" />
      <path d="M4 19.2h16" />
    </>
  ),
  serverUp: (
    <>
      <path d="M12 20.2V9.8M7.8 13.6L12 9.4l4.2 4.2" />
      <path d="M4 4.8h16" />
    </>
  ),
  image: (
    <>
      <rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2" />
      <circle cx="17" cy="12" r="1.1" />
      <path d="M6.6 9.4h6.4" />
    </>
  ),
  send: (
    <>
      <path d="M20.6 3.9L3.6 10.4l6.6 2.9 2.9 6.6 7.5-16z" />
      <path d="M10.2 13.3l10.4-9.4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 7.9v.5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.2h5.8V10" />
      <path d="M19.8 4.2L11 13" />
      <path d="M18.4 13.8v4.4a1.8 1.8 0 01-1.8 1.8H5.8A1.8 1.8 0 014 18.2V7.4a1.8 1.8 0 011.8-1.8h4.4" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  minus: <path d="M6 12h12" />,
  chevronDown: <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />,
  chevronRight: <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  chevronLeft: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  arrowUp: (
    <>
      <path d="M12 19.2V5" />
      <path d="M5.8 11.2L12 5l6.2 6.2" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 4.8V19" />
      <path d="M5.8 12.8L12 19l6.2-6.2" />
    </>
  ),
  file: (
    <>
      <path d="M6.2 3.6h7.2l4.4 4.4v12.4H6.2z" />
      <path d="M13.2 3.8V8h4.2" />
    </>
  ),
  key: (
    <>
      <circle cx="8.2" cy="8.2" r="3.6" />
      <path d="M10.8 10.8L19 19M16 16l2-2M14 14l2-2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.8" y="10.4" width="14.4" height="9.8" rx="2" />
      <path d="M8.2 10.2V7.6a3.8 3.8 0 017.6 0v2.6" />
    </>
  )
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
  title?: string
}

export function Icon({ name, size = 16, className, strokeWidth = 1.6, title }: IconProps): JSX.Element {
  return (
    <svg
      className={className ? `ico ${className}` : 'ico'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}

/** 品牌标记：信封 + 印刷色标（设计稿左上角） */
export function BrandMark({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
      <rect x="5.4" y="7.2" width="15.2" height="10.4" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.8 8.2l7.2 4.6 7.2-4.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.4 20.2h4.6M11.2 20.2h4.6M17 20.2h4.2" stroke="#C8422D" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
