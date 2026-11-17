export type Cache = { read: number; write: number; input: number; output: number; lastRead: number; lastIn: number; lastAt: number }
export type Info = { model: string; branch?: string; dirty: number }
export type Usage = {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null; cache: Cache; isCompact: boolean; info: Info | null }
  }
}
