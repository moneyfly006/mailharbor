/** 一封邮件的多条路径投递结果聚合（按 targetPath 归并；记录页 / 概览共用） */
import type { DeliveryState, RecordRow } from '@shared/types'
import { driveOf } from './format'

const RANK: Record<DeliveryState, number> = {
  failed: 0,
  retry_wait: 1,
  copying: 2,
  pending: 3,
  skipped: 4,
  done: 5
}

export interface DeliverySummary {
  key: string
  targetPath: string
  drive: string
  state: DeliveryState
  required: boolean
  error: string | null
  deliveryIds: number[]
  failedDeliveryIds: number[]
  attempts: number
  nextRetryAt: number | null
  savedPath: string | null
  savedDeliveryId: number | null
}

export function aggregateDeliveries(record: RecordRow): DeliverySummary[] {
  const map = new Map<string, DeliverySummary>()
  for (const att of record.attachments) {
    for (const d of att.deliveries) {
      const key = d.targetPath
      const prev = map.get(key)
      if (!prev) {
        map.set(key, {
          key,
          targetPath: d.targetPath,
          drive: driveOf(d.targetPath),
          state: d.state,
          required: d.required,
          error: d.error,
          deliveryIds: [d.id],
          failedDeliveryIds: d.state === 'failed' || d.state === 'retry_wait' ? [d.id] : [],
          attempts: d.attempts,
          nextRetryAt: d.nextRetryAt,
          savedPath: d.savedPath,
          savedDeliveryId: d.savedPath ? d.id : null
        })
        continue
      }
      prev.required = prev.required || d.required
      prev.deliveryIds.push(d.id)
      if (d.state === 'failed' || d.state === 'retry_wait') prev.failedDeliveryIds.push(d.id)
      if (RANK[d.state] < RANK[prev.state]) {
        prev.state = d.state
        prev.error = d.error ?? prev.error
        prev.nextRetryAt = d.nextRetryAt ?? prev.nextRetryAt
      }
      prev.attempts = Math.max(prev.attempts, d.attempts)
      if (d.savedPath) {
        prev.savedPath = d.savedPath
        prev.savedDeliveryId = d.id
      }
    }
  }
  return Array.from(map.values())
}

export interface FailedDeliveryItem {
  messageId: number
  deliveryId: number
  filename: string
  size: number | null
  targetPath: string
  drive: string
  required: boolean
  state: DeliveryState
  error: string | null
  attempts: number
  nextRetryAt: number | null
}

export function failedDeliveryItems(record: RecordRow): FailedDeliveryItem[] {
  const out: FailedDeliveryItem[] = []
  for (const att of record.attachments) {
    for (const d of att.deliveries) {
      if (d.state !== 'failed' && d.state !== 'retry_wait') continue
      out.push({
        messageId: record.id,
        deliveryId: d.id,
        filename: att.filename,
        size: att.size,
        targetPath: d.targetPath,
        drive: driveOf(d.targetPath),
        required: d.required,
        state: d.state,
        error: d.error,
        attempts: d.attempts,
        nextRetryAt: d.nextRetryAt
      })
    }
  }
  return out
}
