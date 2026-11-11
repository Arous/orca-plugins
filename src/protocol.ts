export interface UsageSnapshot {
  balanceUsd: number
  todayUsd: number
  monthUsd: number
  updatedAt: number
  periodDay: string
  periodMonth: string
}

export type CollectionError =
  | 'login-required'
  | 'page-required'
  | 'team-required'
  | 'account-changed'
  | 'period-changed'
  | 'rate-limited'
  | 'unavailable'
  | 'unexpected-response'
  | 'network-error'

export type CollectionResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; code: 'connection-required'; identityKey: string }
  | { ok: false; code: CollectionError }

export interface BrowserTarget {
  tabId: string
  profileId: string
  worktreeId: string
}

export interface SavedConnection extends BrowserTarget {
  identityKey: string | null
}

export interface BrowserBridge {
  ensureTab(target: BrowserTarget | null, legacyTabId: string | null, signal: AbortSignal): Promise<BrowserTarget>
  revealTab(target: BrowserTarget, signal: AbortSignal): Promise<void>
  collect(target: BrowserTarget, identityKey: string | null, signal: AbortSignal): Promise<CollectionResult>
}

export interface UsageState {
  status: 'loading' | 'ready' | 'login-required' | 'connection-required' | 'unavailable' | 'error'
  message: string
  snapshot: UsageSnapshot | null
  checkedAt: number | null
  refreshing: boolean
  canConnect: boolean
  confirmationKey: string | null
  connected: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'usage.get': { output: UsageState }
    'usage.refresh': { output: UsageState }
    'usage.open': { output: UsageState }
    'usage.connect': { input: { identityKey: string }; output: UsageState }
  }
  interface PluginPanelEvents {
    'usage.changed': UsageState
  }
}
