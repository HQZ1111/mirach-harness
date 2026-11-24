import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { botsStore } from '@/components/panes/hub/bots-store'

import {
  listTrackedDeliveries,
  trackDeliveryFailed,
  trackDeliverySettled,
  trackDeliveryStart,
  trackDeliveryState,
} from './bot-delivery'

const addBot = (name: string) =>
  botsStore.getState().upsert({
    name,
    title: '',
    systemPrompt: '',
    model: '',
    cwd: '',
    description: '',
    createdAt: 0,
  })

let seq = 0

const start = (input: { fromProfile: string; target: string; message?: string }) => {
  const id = `d${++seq}`
  trackDeliveryStart({
    id,
    fromProfile: input.fromProfile,
    target: input.target,
    message: input.message ?? 'hello',
  })
  return id
}

describe('bot delivery registry — hermes bot_delivery.list 的宿主对偶', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'))
    for (const name of ['alice-t1', 'alice-t2', 'alice-t3', 'alice-t4', 'scribe']) {
      if (!botsStore.getState().bots.some((b) => b.name === name)) addBot(name)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists only the sender’s own unsettled deliveries, newest first', () => {
    const sender = 'alice-t1'
    start({ fromProfile: sender, target: 'scribe', message: 'first' })
    vi.advanceTimersByTime(2_000)
    start({ fromProfile: sender, target: 'scribe', message: 'second' })
    start({ fromProfile: 'someone-else', target: 'scribe', message: 'not mine' })

    const rows = listTrackedDeliveries(sender)

    expect(rows.map((r) => r.preview)).toEqual(['second', 'first'])
    expect(rows.every((r) => r.target === 'scribe')).toBe(true)
  })

  it('strips the relay signature and clamps the preview like the gateway', () => {
    const sender = 'alice-t2'
    start({
      fromProfile: sender,
      target: 'scribe',
      message: `Message from 🤖 alice (@alice): ${'x'.repeat(400)}`,
    })

    const [row] = listTrackedDeliveries(sender)

    expect(row?.preview.startsWith('Message from')).toBe(false)
    expect(row?.preview.endsWith('…')).toBe(true)
    expect(row?.preview.length).toBe(140)
  })

  it('settled deliveries drop off; failed ones stay visible for 24h', () => {
    const sender = 'alice-t3'
    const worked = start({ fromProfile: sender, target: 'scribe', message: 'worked' })
    trackDeliveryState(worked, 'working')
    trackDeliverySettled(worked)

    const broke = start({ fromProfile: sender, target: 'scribe', message: 'broke' })
    trackDeliveryFailed(broke, 'provider rejected the key', 'provider_auth_or_access')

    expect(listTrackedDeliveries(sender).map((r) => r.delivery_id)).toEqual([broke])
    expect(listTrackedDeliveries(sender)[0]?.state).toBe('failed')

    vi.advanceTimersByTime(24 * 3600 * 1000 + 1_000)
    expect(listTrackedDeliveries(sender)).toEqual([])
  })

  it('never lists a delivery to a bot outside this install (gateway scans local receipts only)', () => {
    const sender = 'alice-t4'
    start({ fromProfile: sender, target: 'remote-bot', message: 'over the relay' })

    expect(listTrackedDeliveries(sender)).toEqual([])
  })
})
