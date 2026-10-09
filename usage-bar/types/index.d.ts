export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Cat = { name: string; tokens: number }
export type Snap = {
  percent: number
  tokens: number
  window: number
  limits: Limit[]
  usd: number | null
  startedAt: number
  model: string
  cats: Cat[]
  compactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { snap: Snap | null; showTools: boolean; showWhere: boolean; title: string }
  }
}
