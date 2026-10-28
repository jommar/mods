import type { EngineInterface } from 'claude-code'

import { costUsd } from './ledger'
import type { ApiUsage } from './ledger'

export type ReportEvent =
  | {
      type: 'usage'
      agent: string
      model: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      costUsd: number | null
    }
  | { type: 'tool'; agent: string; tool: string }
  | { type: 'agent'; agent: string; label: string; model?: string }
  | { type: 'session'; state: 'start' | 'end' | 'clear'; cwd?: string }

type StampedEvent = ReportEvent & { id: string; v: 1; session: string; ts: number }

const EVENTS_URL = 'http://usage-monitor/events'
const FLUSH_MS = 500
const TIMEOUT_MS = 15_000
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60_000
const MAX_BATCH = 500
const MAX_QUEUE = 2000

// The API rejects a whole batch for one string past its limit, so longer ones are cut on the wire.
const MAX_LENGTH: Record<string, number> = { session: 64, agent: 64, model: 100, tool: 200, label: 300, cwd: 4096 }

const encode = (events: StampedEvent[]): string =>
  JSON.stringify({ events }, (key, value) => {
    const max = MAX_LENGTH[key]

    return typeof value === 'string' && max !== undefined ? value.slice(0, max) : value
  })

export const usageEvent = (agent: string, usage: ApiUsage & { model: string }): ReportEvent => {
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }

  return { type: 'usage', agent, model: usage.model, ...tokens, costUsd: costUsd(usage.model, tokens) ?? null }
}

const queue: StampedEvent[] = []
let isBusy = false
let retryMs = RETRY_MIN_MS

async function send($: EngineInterface, socket: string, events: StampedEvent[]) {
  const stop = new AbortController()
  const timeout = $.clock
    .sleep(TIMEOUT_MS, { signal: stop.signal })
    .then(() => Promise.reject(new Error('usage-monitor API timed out')))

  try {
    const request = $.http.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encode(events),
      socketPath: socket,
    })

    return await Promise.race([request, timeout])
  } finally {
    stop.abort()
  }
}

async function flush($: EngineInterface, socket: string) {
  const batch = queue.splice(0, MAX_BATCH)
  let delay = FLUSH_MS

  // A 4xx means the API refused the contract: that batch is dropped, never retried.
  const isDone = await send($, socket, batch).then(
    response => response.status < 500,
    () => false,
  )

  if (isDone) {
    retryMs = RETRY_MIN_MS
  } else {
    queue.unshift(...batch)
    queue.splice(0, Math.max(0, queue.length - MAX_QUEUE))
    delay = retryMs
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
  }

  isBusy = false

  if (queue.length > 0) {
    schedule($, socket, delay)
  }
}

// One flush is waiting or running at a time; the next is scheduled when it ends.
function schedule($: EngineInterface, socket: string, ms: number) {
  if (isBusy) {
    return
  }

  $.clock.after(ms, () => void flush($, socket).catch(() => {}))
  isBusy = true
}

async function enqueue($: EngineInterface, socket: string, event: ReportEvent, session: string | undefined) {
  const ts = Date.now()
  const id = session ?? (await $.session.id())

  queue.push({ ...event, id: crypto.randomUUID(), v: 1, session: id, ts })
  queue.splice(0, Math.max(0, queue.length - MAX_QUEUE))
  schedule($, socket, FLUSH_MS)
}

/**
 * Queues an event in memory and POSTs queued events to the usage-monitor API over its Unix
 * socket. Does nothing when `socket` is empty. A hook never waits on it: this only starts
 * work, and every failure is swallowed. `session` is the session's id when the event is
 * about one that is not the current one.
 */
export function report($: EngineInterface, socket: string, event: ReportEvent, session?: string) {
  if (socket !== '') {
    void enqueue($, socket, event, session).catch(() => {})
  }
}
