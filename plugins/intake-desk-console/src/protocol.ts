export const DEFAULT_ADVISOR_SCRIPT_PATH = '~/.orca/bots/intake-desk/scripts/route-advisor.mjs'
export const DEFAULT_PENDING_QUEUE_PATH = '~/.orca/bots/intake-desk/memory/pending-approvals.json'
export const DEFAULT_POLL_SECONDS = 30
export const MIN_POLL_SECONDS = 15
export const MAX_POLL_SECONDS = 300
export const A2UI_SURFACE_ID = 'intake_desk_console'
export const A2UI_CATALOG_ID = 'orca.intake_desk.v1'

export type BillingType = 'subscription' | 'payg'
export type AdvisorQuotaStatus =
  | 'ok'
  | 'rate_limited'
  | 'exhausted'
  | 'expiring'
  | 'expired'
  | 'unavailable'
  | 'unknown'
export type RecommendationTrack = 'track2' | 'track3'
export type WorktreeMode = 'new' | 'existing'

export type AdvisorFallbackEntry = {
  agent: string
  model: string
  effort: string
}

export type AdvisorDeskModel = {
  active: string
  effort: string
  fallbackActive: boolean
  fallbackChain: AdvisorFallbackEntry[]
}

export type AdvisorQuota = {
  id: string
  provider: string
  label: string
  billingType: BillingType
  status: AdvisorQuotaStatus
  sessionUsedPct: number | null
  weeklyUsedPct: number | null
  monthlyUsedPct: number | null
  paceRatio: number | null
  resetsAt: string | null
  resetLabel: string | null
  expiresAt: string | null
  burnDownBonus: number
}

export type AdvisorPaygEntry = {
  provider: string
  label: string
  last24hUsd: number
  last7dUsd: number
  estimateKind: string
  warningCap: number | null
}

export type AdvisorAlternative = {
  routeId: string
  shortAlias: string
  agent: string
  model: string
  effort: string
  score: number
  billingType: BillingType
}

export type AdvisorRecommendation = {
  taskId: string
  domain: string | null
  track: RecommendationTrack
  worktreeMode: WorktreeMode
  worktree?: string | null
  routeId: string
  agent: string
  model: string
  effort: string
  billingType: BillingType
  estimatedCostUsd: number
  estimatedMinutes: number
  score: number
  reason: string
  oneLine: string
  alternatives: AdvisorAlternative[]
}

export type AdvisorPayload = {
  schemaVersion: 1
  generatedAt: string
  deskModel: AdvisorDeskModel
  quotas: AdvisorQuota[]
  payg: Record<string, AdvisorPaygEntry>
  unmappedActiveProviders: string[]
  excludedProviders: string[]
  recommendation: AdvisorRecommendation | null
  errors: string[]
}

export type ModelOption = {
  modelId: string
  routeId: string
  shortAlias: string
  agent: string
  model: string
  effort: string
  billingType: BillingType
  label: string
}

export type PendingQueueAckEntry = {
  taskId: string
  createdAt: number
  action: 'approved' | 'handoff' | 'cancelled'
  handledAt: number
}

export type PendingQueueFileItem = {
  taskId: string
  domain: string
  projectId?: string | null
  workspaceId?: string | null
  track: RecommendationTrack
  worktreeMode: WorktreeMode
  worktreeName: string
  title: string
  spec: string
  agent: string
  model: string
  effort: string
  billingType: BillingType
  estimatedCostUsd: number
  estimatedMinutes: number
  reason: string
  oneLine: string
  options?: ModelOption[]
  createdAt: number
}

export type PendingTask = {
  taskId: string
  domain: string
  projectId: string | null
  workspaceId: string | null
  track: RecommendationTrack
  worktreeMode: WorktreeMode
  worktreeName: string
  title: string
  spec: string
  selectedModelId: string
  agent: string
  model: string
  effort: string
  billingType: BillingType
  estimatedCostUsd: number
  estimatedMinutes: number
  reason: string
  oneLine: string
  options: ModelOption[]
  createdAt: number
  source?: 'queue' | 'storage'
}

export type WorkerBoardStatus = 'working' | 'permission' | 'done' | 'handoff' | 'active' | 'inactive'

export type WorkerItem = {
  id: string
  taskId: string | null
  workspaceId: string | null
  domain: string
  projectId: string | null
  name: string
  branch: string | null
  track: string
  modelLabel: string | null
  status: WorkerBoardStatus
  unread: boolean
  terminalCount: number
  lastActivityAt: number | null
  isDeskOwned: boolean
  isActive: boolean
}

export type ConsoleStatus = 'loading' | 'ready' | 'stale' | 'error'

export type ConsoleState = {
  status: ConsoleStatus
  instanceId: string
  revision: number
  advisorScriptPath: string
  pendingQueuePath: string
  advisor: AdvisorPayload | null
  pending: PendingTask[]
  workers: WorkerItem[]
  domains: string[]
  error: string | null
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  refreshing: boolean
}

export type A2UIComponent = {
  id: string
  component: Record<string, unknown>
}

export type A2UIMessage =
  | {
      version: '1.0'
      createSurface: {
        surfaceId: string
        catalogId: string
      }
    }
  | {
      version: '1.0'
      updateComponents: {
        surfaceId: string
        components: A2UIComponent[]
      }
    }
  | {
      version: '1.0'
      updateDataModel: {
        surfaceId: string
        path: string
        value: Record<string, unknown>
      }
    }

export type ApproveTaskInput = {
  taskId: string
  modelId?: string
}

export type OverrideModelInput = {
  taskId: string
  modelId: string
}

export type HandoffTaskInput = {
  taskId: string
  modelId?: string
}

export type CancelTaskInput = {
  taskId: string
}

export type OpenWorkspaceInput = {
  workspaceId: string
}

declare module 'orca' {
  interface PluginRequests {
    'console.get': { output: ConsoleState }
    'console.refresh': { output: ConsoleState }
    'console.approve': { input: ApproveTaskInput; output: ConsoleState }
    'console.overrideModel': { input: OverrideModelInput; output: ConsoleState }
    'console.handoff': { input: HandoffTaskInput; output: ConsoleState }
    'console.cancel': { input: CancelTaskInput; output: ConsoleState }
    'console.openWorkspace': { input: OpenWorkspaceInput; output: ConsoleState }
    'console.a2uiSnapshot': { output: A2UIMessage[] }
  }

  interface PluginPanelEvents {
    'console.changed': ConsoleState
  }
}
