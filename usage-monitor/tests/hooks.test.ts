import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-monitor',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'usage-monitor',
  props: { title: 'Usage', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const

const engineAnswers = (on: On) => {
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
}

test('tool calls are counted and shown in the pane', async ($, on) => {
  engineAnswers(on)
  on('tool.call', () => ({ deny: 'stubbed' }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })

  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /Bash\s+2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 tool calls/ })).toBeDefined()
  await ui.unmount()
})

test('a model request adds its tokens to the main thread', async ($, on) => {
  engineAnswers(on)
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-sonnet-5-5',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 10,
      },
    }
  })

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _chunk of step) {
    // drain
  }

  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /new 100 · cache reads 900 · written 10 · out 50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 requests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-sonnet-5-5/ })).toBeDefined()
  await ui.unmount()
})

test('a spawned subagent is named for its type and task, even after it leaves the agent list', async ($, on) => {
  engineAnswers(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))

  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'look around',
    description: 'find mod files',
    subagentType: 'Explore',
    provider: { plugin: 'test', tier: 'user' },
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
  })

  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: /Explore: find mod files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-haiku-4-5/ })).toBeDefined()
  await ui.unmount()
})
