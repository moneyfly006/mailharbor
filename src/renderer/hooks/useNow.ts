import { useEffect, useState } from 'react'

/** 每秒刷新的当前时间（顶栏时钟 / 倒计时用） */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
