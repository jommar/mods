import type {
  AgentSpawnInput,
  AgentSpawnResult,
  HookStream,
  HttpInit,
  HttpResponse,
  On,
  ToolCallInput,
  ToolCallResult,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MAIN, addToolCall, addUsage, costUsd, emptyLedger, setLabel, setSpawnModel, statusText } from '../hooks/ledger'

const SOCKET = '/run/user/1000/usage-monitor.sock'
const WITH_API = { options: { apiSocket: SOCKET }, timeoutMs: 30_000 }
const MODEL = 'claude-sonnet-5-5'
const USAGE = {
  model: MODEL,
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 10,
}
const OK: HttpResponse = { status: 201, ok: true, headers: {}, text: '{"accepted":1,"duplicates":0}' }

type Event = Record<string, unknown>
type Post = { url: string; init: HttpInit; events: Event[]; at: number }

// The README's "Ingest contract (v1)", as a checker: the first thing wrong with an event, if any.
const isText = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0

function problem(e: Event): string | undefined {
  const fields: [string, boolean][] = [
    ['id', isText(e.id, 1, 64)],
    ['v', e.v === 1],
    ['session', isText(e.session, 1, 64)],
    ['ts', typeof e.ts === 'number' && Number.isInteger(e.ts)],
  ]

  switch (e.type) {
    case 'usage':
      fields.push(
        ['agent', isText(e.agent, 1, 64)],
        ['model', isText(e.model, 1, 100)],
        ['input', isCount(e.input)],
        ['output', isCount(e.output)],
        ['cacheRead', isCount(e.cacheRead)],
        ['cacheWrite', isCount(e.cacheWrite)],
        ['costUsd', e.costUsd === null || (typeof e.costUsd === 'number' && e.costUsd >= 0)],
      )
      break
    case 'tool':
      fields.push(['agent', isText(e.agent, 1, 64)], ['tool', isText(e.tool, 1, 200)])
      break
    case 'agent':
      fields.push(
        ['agent', isText(e.agent, 1, 64)],
        ['label', isText(e.label, 0, 300)],
        ['model', e.model === undefined || typeof e.model === 'string'],
      )
      break
    case 'session':
      fields.push(
        ['state', e.state === 'start' || e.state === 'end' || e.state === 'clear'],
        ['cwd', e.cwd === undefined || isText(e.cwd, 0, 4096)],
      )
      break
    default:
      fields.push(['type', false])
  }

  return fields.find(([, isValid]) => !isValid)?.[0]
}

// What stands beneath the mod's hooks in place of the defaults, for a test that needs other answers.
type Below = {
  toolCall?: (e: ToolCallInput) => ToolCallResult
  spawn?: (e: AgentSpawnInput) => AgentSpawnResult
  step?: (e: TurnStepInput) => AsyncGenerator<TurnStepChunk, TurnStepResult>
  rewrite?: (input: Record<string, unknown>) => Record<string, unknown> | undefined
}

// The engine beneath the mod, with the API behind `answer` (called with the request's number, from 1).
const world = (
  on: On,
  answer: (n: number) => Promise<HttpResponse> | HttpResponse = () => OK,
  usage = USAGE,
  below: Below = {},
) => {
  const clock = mock.clock(on)
  const posts: Post[] = []
  const statuses: (string | undefined)[] = []

  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('command.register', () => ({ value: { command: 'usage-monitor' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.call', (_, e) => below.toolCall?.(e) ?? { deny: 'stubbed' })
  on('agent.spawn', (_, e) => below.spawn?.(e) ?? { model: 'claude-haiku-4-5', agentId: 'agent-1' })
  on('turn.step', async function* (_, e) {
    if (below.step !== undefined) {
      return yield* below.step(e)
    }

    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage,
    }
  })
  if (below.rewrite !== undefined) {
    on('classic.PreToolUse', (_, e) => ({ updatedInput: below.rewrite?.(e) }))
  }

  on('http.fetch', async (_, e) => {
    const init = e.init ?? {}

    posts.push({ url: e.url, init, events: JSON.parse(init.body ?? '{}').events, at: clock.now() })

    return { value: await answer(posts.length) }
  })

  return { clock, posts, statuses }
}

const spawn = ($: Engine, description = 'look') =>
  $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'look around',
    description,
    subagentType: 'Explore',
    provider: { plugin: 'test', tier: 'user' },
    parentModel: MODEL,
    background: false,
    fork: false,
  })

const step = async ($: Engine, agentId?: string) => {
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: MODEL, messageCount: 1, agentId })) {
    // drain
  }
}

// One of each thing the mod counts.
const workload = async ($: Engine) => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await spawn($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await step($)
}

const PANE = {
  plugin: 'usage-monitor',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'usage-monitor',
  props: { title: 'Usage', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const

// What the status line and the pane must say after `workload`, whether or not the API answers.
const expectLedgerAsWithoutApi = async ($: Engine, statuses: (string | undefined)[]) => {
  const spawned = setSpawnModel(setLabel(emptyLedger(), 'agent-1', 'Explore: look'), 'agent-1', 'claude-haiku-4-5')
  const withTool = addToolCall(spawned, MAIN, 'Bash')

  expect(statuses).toEqual([undefined, statusText(withTool), statusText(addUsage(withTool, MAIN, MODEL, USAGE))])

  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /new 100 · cache reads 900 · written 10 · out 50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Explore: look/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 tool calls/ })).toBeDefined()
  await ui.unmount()
}

const tools = (n: number) => Array.from({ length: n }, (_, i) => `tool-${i}`)

const burst = async ($: Engine, names: string[]) => {
  for (const tool of names) {
    await $.tool.call({ tool, command: 'x' } as never)
  }
}

for (const [name, options] of [
  ['unset', {}],
  ['empty', { options: { apiSocket: '' } }],
] as const) {
  test(`apiSocket ${name}: nothing is sent and the ledger and status line are as before`, options, async ($, on) => {
    const { clock, posts, statuses } = world(on)

    await workload($)
    await clock.advance(120_000)

    expect(posts).toHaveLength(0)
    await expectLedgerAsWithoutApi($, statuses)
  })
}

test('each event type is POSTed as the ingest contract says', WITH_API, async ($, on) => {
  const { clock, posts } = world(on)

  await workload($)
  await spawn($, 'x'.repeat(400))
  await $.session.end({ reason: 'clear', sessionId: 'old-session', resume: { id: 'old-session' } })
  await $.session.end({ reason: 'other', sessionId: 'last-session', resume: { id: 'last-session' } })
  await clock.advance(500)

  expect(posts).toHaveLength(1)
  expect(posts[0]?.url).toBe('http://usage-monitor/events')
  expect(posts[0]?.init.method).toBe('POST')
  expect(posts[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
  expect(posts[0]?.init.socketPath).toBe(SOCKET)

  const events = posts[0]?.events ?? []

  // An event about another session is queued without asking for the current id, so it can pass one that asks.
  const of = (type: string, state?: string) => events.filter(e => e.type === type && (state === undefined || e.state === state))

  expect(events).toHaveLength(7)
  expect(events.map(problem)).toEqual(events.map(() => undefined))
  expect(new Set(events.map(e => e.id)).size).toBe(events.length)
  expect(of('session', 'start')[0]).toMatchObject({ cwd: '/work', session: 'session-1' })
  expect(of('agent')[0]).toMatchObject({ agent: 'agent-1', label: 'Explore: look', model: 'claude-haiku-4-5' })
  expect(of('tool')[0]).toMatchObject({ agent: MAIN, tool: 'Bash' })
  expect(of('usage')[0]).toMatchObject({
    agent: MAIN,
    model: MODEL,
    input: 100,
    output: 50,
    cacheRead: 900,
    cacheWrite: 10,
    costUsd: costUsd(MODEL, { input: 100, output: 50, cacheRead: 900, cacheWrite: 10 }),
  })
  expect((of('agent')[1]?.label as string).length).toBe(300)
  expect(of('session', 'clear')[0]).toMatchObject({ session: 'old-session' })
  expect(of('session', 'end')[0]).toMatchObject({ session: 'last-session' })
})

test('a model with no list price is sent with a null cost, a subagent by its own id', WITH_API, async ($, on) => {
  const { clock, posts } = world(on, () => OK, { ...USAGE, model: 'mystery-1' })

  await step($, 'agent-1')
  await clock.advance(500)

  expect(posts[0]?.events[0]).toMatchObject({ type: 'usage', agent: 'agent-1', model: 'mystery-1', costUsd: null })
})

test('a burst goes out in few POSTs of at most 500 events, one at a time', WITH_API, async ($, on) => {
  let open = 0
  let most = 0
  const { clock, posts } = world(on, async () => {
    open += 1
    most = Math.max(most, open)
    await clock.sleep(50)
    open -= 1

    return OK
  })

  await burst($, tools(30))
  await clock.advance(500)
  expect(posts.map(p => p.events.length)).toEqual([30])

  await burst($, tools(1200))
  await clock.advance(10_000)

  expect(posts.map(p => p.events.length)).toEqual([30, 500, 500, 200])
  expect(new Set(posts.flatMap(p => p.events.map(e => e.id))).size).toBe(1230)
  expect(most).toBe(1)
})

test('API down: the hooks still answer, with the ledger and status line as without it', WITH_API, async ($, on) => {
  const { clock, posts, statuses } = world(on, () => {
    throw new Error('connect ECONNREFUSED')
  })

  await workload($)
  await clock.advance(500)

  expect(posts).toHaveLength(1)
  await expectLedgerAsWithoutApi($, statuses)
})

test('API hung: the hooks never wait on it, and a request that never answers is given up on', WITH_API, async ($, on) => {
  const { clock, posts, statuses } = world(on, () => new Promise<HttpResponse>(() => {}))

  await workload($)
  await clock.advance(500)
  expect(posts).toHaveLength(1)

  await expectLedgerAsWithoutApi($, statuses)

  await burst($, ['Read'])
  await clock.advance(15_000 + 2000)

  const first = posts[0]?.events.map(e => e.id) ?? []

  expect(posts).toHaveLength(2)
  expect(posts[1]?.events.slice(0, first.length).map(e => e.id)).toEqual(first)
  expect(posts[1]?.events.map(e => e.tool)).toEqual([undefined, undefined, 'Bash', undefined, 'Read'])
})

test('a 4xx drops the batch and is not retried', WITH_API, async ($, on) => {
  const { clock, posts } = world(on, n => (n === 1 ? { status: 400, ok: false, headers: {}, text: '{"error":"bad"}' } : OK))

  await burst($, tools(3))
  await clock.advance(500)
  await clock.advance(300_000)
  expect(posts).toHaveLength(1)

  await burst($, ['next'])
  await clock.advance(500)

  expect(posts).toHaveLength(2)
  expect(posts[1]?.events.map(e => e.tool)).toEqual(['next'])
})

test('a 5xx or a network error keeps the batch and resends the same ids with backoff', WITH_API, async ($, on) => {
  let n = 0
  const { clock, posts } = world(on, () => {
    n += 1

    if (n % 2 === 1) {
      throw new Error('socket hang up')
    }

    return { status: 503, ok: false, headers: {}, text: '' }
  })

  await burst($, tools(3))
  await clock.advance(500)
  await burst($, ['late'])
  await clock.advance(400_000)

  const first = posts[0]?.events.map(e => e.id) ?? []

  expect(first).toHaveLength(3)
  expect(posts[1]?.events.map(e => e.id)).toEqual([...first, posts[1]?.events.at(-1)?.id])
  expect(posts[2]?.events.map(e => e.id)).toEqual(posts[1]?.events.map(e => e.id))
  expect(posts[1]?.events.map(e => e.tool)).toEqual(['tool-0', 'tool-1', 'tool-2', 'late'])
  expect(posts.slice(1).map((p, i) => p.at - (posts[i]?.at ?? 0)).slice(0, 8)).toEqual([
    2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ])
})

test('after an outage the batch is delivered once, then the rest', WITH_API, async ($, on) => {
  let isDown = true
  const { clock, posts } = world(on, () => (isDown ? { status: 500, ok: false, headers: {}, text: '' } : OK))

  await burst($, tools(3))
  await clock.advance(500)
  isDown = false
  await clock.advance(2000)
  await clock.advance(120_000)

  expect(posts.map(p => p.events.length)).toEqual([3, 3])
})

test('past 2000 queued events the oldest are dropped', WITH_API, async ($, on) => {
  let isDown = true
  const { clock, posts } = world(on, () => {
    if (isDown) {
      throw new Error('connect ECONNREFUSED')
    }

    return OK
  })

  await burst($, tools(2100))
  await clock.advance(500)

  expect(posts[0]?.events).toHaveLength(500)
  expect(posts[0]?.events[0]?.tool).toBe('tool-100')

  isDown = false
  await clock.advance(120_000)

  const delivered = posts.slice(1).flatMap(p => p.events.map(e => e.tool))

  expect(posts.slice(1).map(p => p.events.length)).toEqual([500, 500, 500, 500])
  expect(delivered).toEqual(tools(2100).slice(100))
})

test('a 5000-character cwd goes out as 4096, while the hook still answers with the whole path', WITH_API, async ($, on) => {
  const { clock, posts } = world(on)
  const cwd = `/${'d'.repeat(4999)}`

  const started = await $.session.start({ cwd, surface: 'terminal', isInteractive: true })

  await clock.advance(500)

  const [event] = posts[0]?.events ?? []

  expect(cwd).toHaveLength(5000)
  expect(started).toStrictEqual({ cwd })
  expect(event).toMatchObject({ type: 'session', state: 'start', cwd: cwd.slice(0, 4096) })
  expect(String(event?.cwd)).toHaveLength(4096)
  expect(event && problem(event)).toBeUndefined()
})

// What the engine beneath the mod's hooks answers; each answer must come back up exactly as it is.
const CHUNKS: TurnStepChunk[] = [
  { kind: 'text', index: 0, text: 'he' },
  { kind: 'text', index: 0, text: 'llo' },
]
const STEP: TurnStepResult = {
  turnId: 't1',
  index: 0,
  answer: 'hello',
  toolUses: [],
  stopReason: 'end_turn',
  usage: USAGE,
}
const QUIET: TurnStepResult = { ...STEP, answer: '', usage: null }
const BELOW: Below = {
  toolCall: e => {
    const command = e.tool === 'Bash' ? e.command : ''

    return command === 'rm -rf /' ? { deny: 'blocked' } : { result: { ran: command }, text: `ran ${command}` }
  },
  spawn: e =>
    e.description === 'orphan' ? { model: 'claude-haiku-4-5' } : { model: 'claude-haiku-4-5', agentId: 'agent-1' },
  step: async function* (e) {
    if (e.agentId === 'quiet') {
      return QUIET
    }

    yield* CHUNKS

    return STEP
  },
  // A settings hook beneath the mod rewrites `ls`; the tool then ran `ls -la`, and says so.
  rewrite: input => (input.command === 'ls' ? { tool: 'Bash', command: 'ls -la' } : undefined),
}
const ANSWERS = {
  start: { cwd: '/work' },
  spawned: { model: 'claude-haiku-4-5', agentId: 'agent-1' },
  orphan: { model: 'claude-haiku-4-5' },
  rewritten: { result: { ran: 'ls -la' }, text: 'ran ls -la' },
  denied: { deny: 'blocked' },
  step: { chunks: CHUNKS, result: STEP },
  quiet: { chunks: [], result: QUIET },
  endOther: { sessionId: 'last-session' },
  endClear: { sessionId: 'old-session' },
}

const NEVER = () => new Promise<HttpResponse>(() => {})
const REFUSED = (): HttpResponse => {
  throw new Error('connect ECONNREFUSED')
}

const stepAnswer = async ($: Engine, agentId?: string) => {
  const stream: HookStream<TurnStepChunk, TurnStepResult> = $.turn.step({
    turnId: 't1',
    index: 0,
    model: MODEL,
    messageCount: 1,
    agentId,
  })
  const chunks: TurnStepChunk[] = []

  // The result is what `next()` ends with: the stream's own `.result` came back undefined on a call from `$`.
  for (;;) {
    const piece = await stream.next()

    if (piece.done === true) {
      return { chunks, result: piece.value }
    }

    chunks.push(piece.value)
  }
}

// The first row is the control: with no API the same answers must come back, so the rest are held to it.
for (const [name, options, answer, posted] of [
  ['no API', {}, () => OK, 0],
  ['API answering', WITH_API, () => OK, 1],
  ['API refusing the connection', WITH_API, REFUSED, 1],
  ['API never answering', WITH_API, NEVER, 1],
] as const) {
  test(`${name}: every hook the mod touches answers as without the API`, options, async ($, on) => {
    const { clock, posts, statuses } = world(on, answer, USAGE, BELOW)
    const answers: Record<string, unknown> = {}

    answers.start = await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    answers.spawned = await spawn($)
    answers.orphan = await spawn($, 'orphan')
    answers.rewritten = await $.tool.call({ tool: 'Bash', command: 'ls' })
    answers.denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })
    answers.step = await stepAnswer($)
    answers.quiet = await stepAnswer($, 'quiet')
    answers.endOther = await $.session.end({
      reason: 'other',
      sessionId: 'last-session',
      resume: { id: 'last-session' },
    })

    const full = await $.ui.mount(PANE)

    expect(await full.find({ type: 'Text', text: /Explore: look/ })).toBeDefined()
    await full.unmount()

    answers.endClear = await $.session.end({ reason: 'clear', sessionId: 'old-session', resume: { id: 'old-session' } })

    expect(answers).toStrictEqual(ANSWERS)

    // The ledger and status line as before: counted through every answer, and zeroed by the clear.
    const spawned = setSpawnModel(setLabel(emptyLedger(), 'agent-1', 'Explore: look'), 'agent-1', 'claude-haiku-4-5')
    const once = addToolCall(spawned, MAIN, 'Bash')
    const twice = addToolCall(once, MAIN, 'Bash')

    const counted = addUsage(twice, MAIN, MODEL, USAGE)

    expect(statuses).toEqual([undefined, statusText(once), statusText(twice), statusText(counted), undefined])

    const cleared = await $.ui.mount(PANE)

    expect(await cleared.find({ type: 'Text', text: /Explore: look/ })).toBeUndefined()
    expect(await cleared.find({ type: 'Text', text: /Main thread/ })).toBeUndefined()
    await cleared.unmount()

    await clock.advance(500)
    expect(posts).toHaveLength(posted)

    if (posted > 0) {
      // start, the one agent that has an id, two tool calls, the one request that has usage, end and clear
      expect(posts[0]?.events).toHaveLength(7)
    }

    // Retries and the 15 s give-up run their course with nothing thrown into a hook or out of the test.
    await clock.advance(120_000)
  })
}
