import { expect, test } from 'claude-code/testing'

import {
  MAIN,
  addToolCall,
  addUsage,
  cacheHitPercent,
  compact,
  costUsd,
  emptyLedger,
  modelText,
  setLabel,
  setSpawnModel,
  subagentIds,
  tokenLine,
  toolCount,
  totals,
  usd,
} from '../hooks/ledger'

const MILLION = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
}

test('prices each token class at its own rate', () => {
  const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }

  const cents = (model: string) => Math.round((costUsd(model, tokens) ?? NaN) * 100)

  expect(cents('claude-sonnet-5-5')).toBe(1470)
  expect(cents('claude-opus-5-5')).toBe(2920)
  expect(cents('claude-fable-5-1')).toBe(7275)
  expect(cents('claude-haiku-4-5-20251001')).toBe(735)
  expect(costUsd('some-other-model', tokens)).toBeUndefined()
})

test('keeps main thread and each subagent apart', () => {
  let ledger = emptyLedger()
  ledger = addUsage(ledger, MAIN, 'claude-sonnet-5-5', MILLION)
  ledger = addUsage(ledger, 'agent-1', 'claude-haiku-4-5', {
    ...MILLION,
    input_tokens: 10,
  })
  ledger = addUsage(ledger, 'agent-1', 'claude-haiku-4-5', MILLION)

  expect(subagentIds(ledger)).toEqual(['agent-1'])
  expect(ledger.rows[MAIN]?.requests).toBe(1)
  expect(ledger.rows['agent-1']?.requests).toBe(2)
  expect(ledger.rows['agent-1']?.tokens.cacheRead).toBe(2_000_000)
  expect(totals(ledger).requests).toBe(3)
})

test('an unknown model adds tokens but no cost, and is reported', () => {
  const ledger = addUsage(emptyLedger(), 'agent-1', 'mystery-1', MILLION)

  expect(ledger.rows['agent-1']?.costUsd).toBe(0)
  expect(ledger.rows['agent-1']?.tokens.output).toBe(1_000_000)
  expect(totals(ledger).unpricedModels).toEqual(['mystery-1'])
})

test('counts tool calls per agent and per tool', () => {
  let ledger = emptyLedger()
  ledger = addToolCall(ledger, MAIN, 'Bash')
  ledger = addToolCall(ledger, MAIN, 'Bash')
  ledger = addToolCall(ledger, 'agent-1', 'Bash')
  ledger = addToolCall(ledger, 'agent-1', 'Read')

  expect(toolCount(ledger.rows['agent-1']!)).toBe(2)
  expect(totals(ledger).tools).toEqual({ Bash: 3, Read: 1 })
})

test('formats counts, cost and cache hit rate', () => {
  expect(compact(950)).toBe('950')
  expect(compact(1234)).toBe('1.2k')
  expect(compact(45_000)).toBe('45k')
  expect(compact(2_500_000)).toBe('2.50M')
  expect(usd(0.004)).toBe('<$0.01')
  expect(usd(1.234)).toBe('$1.23')
  expect(cacheHitPercent({ input: 100, output: 5, cacheRead: 900, cacheWrite: 0 })).toBe(90)
  expect(cacheHitPercent({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
})

test('a label sticks to its row and survives later usage', () => {
  let ledger = setLabel(emptyLedger(), 'agent-1', 'Explore: find files')
  ledger = addUsage(ledger, 'agent-1', 'claude-haiku-4-5', MILLION)

  expect(ledger.rows['agent-1']?.label).toBe('Explore: find files')
  expect(ledger.rows['agent-1']?.requests).toBe(1)
})

test('the token line leads with the total', () => {
  const ledger = addUsage(emptyLedger(), 'agent-1', 'claude-haiku-4-5', {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 700,
  })

  expect(tokenLine(ledger.rows['agent-1']!)).toBe(
    '26k tokens (new 1.0k · cache reads 24k · written 700 · out 500) · <$0.01',
  )
})

test('a row that only ran tools, with no label and no request, is not a subagent', () => {
  let ledger = addToolCall(emptyLedger(), 'ghost', 'Bash')
  ledger = setLabel(ledger, 'spawned', 'Explore: find files')
  ledger = addUsage(ledger, 'unlabeled', 'claude-haiku-4-5', MILLION)

  expect(subagentIds(ledger)).toEqual(['spawned', 'unlabeled'])
  expect(totals(ledger).tools).toEqual({ Bash: 1 })
})

test('records each model a loop used, once, and falls back to the spawn model', () => {
  let ledger = setSpawnModel(emptyLedger(), 'agent-1', 'haiku')

  expect(modelText(ledger.rows['agent-1']!)).toBe('haiku')

  ledger = addUsage(ledger, 'agent-1', 'claude-haiku-4-5-20251001', MILLION)
  ledger = addUsage(ledger, 'agent-1', 'claude-haiku-4-5-20251001', MILLION)
  ledger = addUsage(ledger, 'agent-1', 'claude-sonnet-5-5', MILLION)

  expect(modelText(ledger.rows['agent-1']!)).toBe('claude-haiku-4-5-20251001, claude-sonnet-5-5')
})
