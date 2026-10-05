import type { UsageLedger, UsageRow, UsageTokens } from '../types'

export const MAIN = 'main'

type Rate = { match: string; input: number; output: number; cacheRead: number }

const CACHE_WRITE_MULTIPLIER = 1.25

const RATES: readonly Rate[] = [
  { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'fable', input: 10, output: 50, cacheRead: 1 },
  { match: 'mythos', input: 10, output: 50, cacheRead: 1 },
  { match: 'opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { match: 'opus', input: 5, output: 25, cacheRead: 0.5 },
  { match: 'sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1 },
]

export const emptyLedger = (): UsageLedger => ({ rows: {} })

const emptyRow = (): UsageRow => ({
  models: [],
  requests: 0,
  tools: {},
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  unpricedModels: [],
})

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function costUsd(model: string, tokens: UsageTokens): number | undefined {
  const rate = RATES.find(r => model.includes(r.match))

  if (rate === undefined) {
    return undefined
  }

  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  )
}

const withRow = (
  ledger: UsageLedger,
  agent: string,
  change: (row: UsageRow) => UsageRow,
): UsageLedger => ({
  rows: { ...ledger.rows, [agent]: change({ ...emptyRow(), ...ledger.rows[agent] }) },
})

export function addUsage(
  ledger: UsageLedger,
  agent: string,
  model: string,
  usage: ApiUsage,
): UsageLedger {
  const step: UsageTokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  const priced = costUsd(model, step)

  return withRow(ledger, agent, row => ({
    ...row,
    requests: row.requests + 1,
    models: row.models.includes(model) ? row.models : [...row.models, model],
    tokens: {
      input: row.tokens.input + step.input,
      output: row.tokens.output + step.output,
      cacheRead: row.tokens.cacheRead + step.cacheRead,
      cacheWrite: row.tokens.cacheWrite + step.cacheWrite,
    },
    costUsd: row.costUsd + (priced ?? 0),
    unpricedModels:
      priced === undefined && !row.unpricedModels.includes(model)
        ? [...row.unpricedModels, model]
        : row.unpricedModels,
  }))
}

export const setLabel = (ledger: UsageLedger, agent: string, label: string): UsageLedger =>
  withRow(ledger, agent, row => ({ ...row, label }))

export const setSpawnModel = (ledger: UsageLedger, agent: string, model: string): UsageLedger =>
  withRow(ledger, agent, row => ({ ...row, spawnModel: model }))

export const modelText = (row: UsageRow): string =>
  row.models.length > 0 ? row.models.join(', ') : (row.spawnModel ?? '')

export const totalTokens = (tokens: UsageTokens): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

export const addToolCall = (ledger: UsageLedger, agent: string, tool: string): UsageLedger =>
  withRow(ledger, agent, row => ({
    ...row,
    tools: { ...row.tools, [tool]: (row.tools[tool] ?? 0) + 1 },
  }))

export const toolCount = (row: UsageRow): number =>
  Object.values(row.tools).reduce((sum, n) => sum + n, 0)

export function totals(ledger: UsageLedger): UsageRow {
  const sum = emptyRow()

  for (const row of Object.values(ledger.rows)) {
    sum.requests += row.requests
    sum.costUsd += row.costUsd
    sum.tokens.input += row.tokens.input
    sum.tokens.output += row.tokens.output
    sum.tokens.cacheRead += row.tokens.cacheRead
    sum.tokens.cacheWrite += row.tokens.cacheWrite

    for (const [tool, n] of Object.entries(row.tools)) {
      sum.tools[tool] = (sum.tools[tool] ?? 0) + n
    }

    for (const model of row.unpricedModels) {
      if (!sum.unpricedModels.includes(model)) {
        sum.unpricedModels.push(model)
      }
    }
  }

  return sum
}

const isSubagentRow = (row: UsageRow): boolean => row.label !== undefined || row.requests > 0

export const subagentIds = (ledger: UsageLedger): string[] =>
  Object.entries(ledger.rows)
    .filter(([id, row]) => id !== MAIN && isSubagentRow(row))
    .map(([id]) => id)

export function compact(n: number): string {
  if (n < 1000) {
    return String(n)
  }

  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  }

  return `${(n / 1_000_000).toFixed(2)}M`
}

export const usd = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

const estimate = (cost: number, isPartial: boolean): string => {
  const text = usd(cost)
  const approx = text.startsWith('<') ? text : `~${text}`

  return isPartial ? `${approx}+` : approx
}

export function cacheHitPercent(tokens: UsageTokens): number {
  const read = tokens.input + tokens.cacheRead + tokens.cacheWrite

  return read === 0 ? 0 : Math.round((tokens.cacheRead / read) * 100)
}

export function tokenLine(row: UsageRow): string {
  const { input, output, cacheRead, cacheWrite } = row.tokens
  const cost = estimate(row.costUsd, row.unpricedModels.length > 0)

  return `${compact(totalTokens(row.tokens))} tokens (new ${compact(input)} · cache reads ${compact(cacheRead)} · written ${compact(cacheWrite)} · out ${compact(output)}) · ${cost}`
}

export function statusText(ledger: UsageLedger): string {
  const all = totals(ledger)
  const { input, output, cacheRead, cacheWrite } = all.tokens
  const subs = subagentIds(ledger).length
  const cost = estimate(all.costUsd, all.unpricedModels.length > 0)

  return `in ${compact(input + cacheRead + cacheWrite)} (${cacheHitPercent(all.tokens)}% cached) · out ${compact(output)} · ${cost} · ${compact(toolCount(all))} tools${subs > 0 ? ` · ${subs} subagents` : ''}`
}
