export type UsageTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type UsageRow = {
  label?: string
  spawnModel?: string
  models: string[]
  requests: number
  tools: Record<string, number>
  tokens: UsageTokens
  costUsd: number
  unpricedModels: string[]
}

export type UsageLedger = { rows: Record<string, UsageRow> }

declare module 'claude-code' {
  interface PluginState {
    'usage-monitor': { ledger: UsageLedger }
  }
}
