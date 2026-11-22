import type {
  AdvisorPayload,
  ConsoleState,
  ModelOption,
  PendingTask,
  WorkerItem
} from './protocol'
import { DEFAULT_ADVISOR_SCRIPT_PATH, DEFAULT_PENDING_QUEUE_PATH } from './protocol'

export const liveAdvisorPayload: AdvisorPayload = {
  schemaVersion: 1,
  generatedAt: '2026-11-22T16:40:00.000Z',
  deskModel: {
    active: 'openai-codex/gpt-6.2-astra',
    effort: 'medium',
    fallbackActive: false,
    fallbackChain: [
      { agent: 'omp', model: 'openai-codex/gpt-6.2-astra', effort: 'medium' },
      { agent: 'antigravity', model: 'claude-sonnet-5-5-medium', effort: 'medium' },
      { agent: 'omp', model: 'opengateway/deepseek/deepseek-v4.1-flash-eco', effort: 'high' }
    ]
  },
  quotas: [
    {
      id: 'codex',
      provider: 'codex',
      label: 'Codex ProMax',
      billingType: 'subscription',
      status: 'ok',
      sessionUsedPct: null,
      weeklyUsedPct: 9,
      monthlyUsedPct: null,
      paceRatio: 0.63,
      resetsAt: '2026-11-29T00:12:00.000Z',
      resetLabel: 'Sun 12:12 AM',
      expiresAt: null,
      burnDownBonus: 0
    },
    {
      id: 'antigravity:claude-gpt',
      provider: 'antigravity',
      label: 'AG Claude & GPT',
      billingType: 'subscription',
      status: 'ok',
      sessionUsedPct: 0,
      weeklyUsedPct: 0,
      monthlyUsedPct: null,
      paceRatio: 0.0,
      resetsAt: null,
      resetLabel: '여유 100%',
      expiresAt: null,
      burnDownBonus: 0
    },
    {
      id: 'antigravity:gemini',
      provider: 'antigravity',
      label: 'AG Gemini Models',
      billingType: 'subscription',
      status: 'ok',
      sessionUsedPct: 66,
      weeklyUsedPct: 53,
      monthlyUsedPct: null,
      paceRatio: 1.38,
      resetsAt: '2026-11-22T18:30:00.000Z',
      resetLabel: '1h 50m',
      expiresAt: null,
      burnDownBonus: 0
    },
    {
      id: 'opencodeGo',
      provider: 'opencodeGo',
      label: 'OpenCode Go',
      billingType: 'subscription',
      status: 'ok',
      sessionUsedPct: 0,
      weeklyUsedPct: 40,
      monthlyUsedPct: 67,
      paceRatio: 0.92,
      resetsAt: '2026-11-23T09:00:00.000Z',
      resetLabel: '주간 17h 리셋',
      expiresAt: null,
      burnDownBonus: 0
    }
  ],
  payg: {
    opengateway: {
      provider: 'opengateway',
      label: 'OpenGateway (종량제)',
      last24hUsd: 25.83,
      last7dUsd: 223.0,
      estimateKind: 'list-price-estimate',
      warningCap: null
    }
  },
  unmappedActiveProviders: [],
  excludedProviders: ['anthropic-direct'],
  recommendation: {
    taskId: '#T1',
    domain: 'TennisClubManagement',
    worktree: 'desk-tcm-tier-race',
    track: 'track2',
    worktreeMode: 'new',
    routeId: 'codex-astra-high',
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    billingType: 'subscription',
    estimatedCostUsd: 0,
    estimatedMinutes: 15,
    score: 92,
    reason: 'Codex 주간 9% 여유 / Antigravity Gemini 주간 53% 우회',
    oneLine: 'codex / gpt-6-astra (high) · Track 2 · 새 워크트리 · 구독 $0',
    alternatives: [
      {
        routeId: 'ag-opus-high',
        shortAlias: 'opus',
        agent: 'antigravity',
        model: 'claude-opus-5-5-high',
        effort: 'high',
        score: 89,
        billingType: 'subscription'
      },
      {
        routeId: 'ag-sonnet-high',
        shortAlias: 'sonnet',
        agent: 'antigravity',
        model: 'claude-sonnet-5-5-high',
        effort: 'high',
        score: 86,
        billingType: 'subscription'
      },
      {
        routeId: 'omp-deepseek-eco',
        shortAlias: 'omp',
        agent: 'omp',
        model: 'opengateway/deepseek/deepseek-v4.1-flash-eco',
        effort: 'high',
        score: 74,
        billingType: 'payg'
      }
    ]
  },
  errors: []
}

export const codex429AdvisorPayload: AdvisorPayload = {
  ...liveAdvisorPayload,
  deskModel: {
    ...liveAdvisorPayload.deskModel,
    active: 'antigravity/claude-sonnet-5-5-medium',
    effort: 'medium',
    fallbackActive: true
  },
  quotas: [
    {
      ...liveAdvisorPayload.quotas[0],
      status: 'rate_limited',
      weeklyUsedPct: 100,
      paceRatio: 2.1,
      resetLabel: 'Sun 12:12 AM 리셋 대기'
    },
    ...liveAdvisorPayload.quotas.slice(1)
  ],
  recommendation: {
    taskId: '#T1',
    domain: 'TennisClubManagement',
    worktree: 'desk-tcm-tier-race',
    track: 'track2',
    worktreeMode: 'new',
    routeId: 'ag-opus-high',
    agent: 'antigravity',
    model: 'claude-opus-5-5-high',
    effort: 'high',
    billingType: 'subscription',
    estimatedCostUsd: 0,
    estimatedMinutes: 15,
    score: 89,
    reason: 'Codex 429 한도 도달로 Antigravity Claude Opus 5.5(0%) 자동 폴백',
    oneLine: 'antigravity / claude-opus-5-5-high · Track 2 · 구독 $0',
    alternatives: [
      {
        routeId: 'ag-sonnet-high',
        shortAlias: 'sonnet',
        agent: 'antigravity',
        model: 'claude-sonnet-5-5-high',
        effort: 'high',
        score: 86,
        billingType: 'subscription'
      }
    ]
  },
  errors: ['codex: 429 rate_limited']
}

export const newSubAdvisorPayload: AdvisorPayload = {
  ...liveAdvisorPayload,
  unmappedActiveProviders: ['cursor']
}

export const expiringAdvisorPayload: AdvisorPayload = {
  ...liveAdvisorPayload,
  quotas: liveAdvisorPayload.quotas.map((q) =>
    q.id === 'opencodeGo'
      ? {
          ...q,
          expiresAt: '2026-11-25T23:59:59.000Z',
          resetLabel: '만료 D-3',
          burnDownBonus: 25
        }
      : q
  )
}

const sampleOptions: ModelOption[] = [
  {
    modelId: 'codex/gpt-6-astra:high',
    routeId: 'codex-astra-high',
    shortAlias: 'codex',
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    billingType: 'subscription',
    label: 'codex / gpt-6-astra (high) · 구독 $0'
  },
  {
    modelId: 'antigravity/claude-opus-5-5-high:high',
    routeId: 'ag-opus-high',
    shortAlias: 'opus',
    agent: 'antigravity',
    model: 'claude-opus-5-5-high',
    effort: 'high',
    billingType: 'subscription',
    label: 'antigravity / claude-opus-5-5-high (high) · 구독 $0'
  },
  {
    modelId: 'antigravity/claude-sonnet-5-5-high:high',
    routeId: 'ag-sonnet-high',
    shortAlias: 'sonnet',
    agent: 'antigravity',
    model: 'claude-sonnet-5-5-high',
    effort: 'high',
    billingType: 'subscription',
    label: 'antigravity / claude-sonnet-5-5-high (high) · 구독 $0'
  }
]

export const unavailableQuotaAdvisorPayload: AdvisorPayload = {
  ...liveAdvisorPayload,
  quotas: [
    ...liveAdvisorPayload.quotas,
    {
      id: 'antigravity:argon',
      provider: 'antigravity',
      label: 'AG Gemini 4 Argon',
      billingType: 'subscription',
      status: 'unavailable',
      sessionUsedPct: null,
      weeklyUsedPct: null,
      monthlyUsedPct: null,
      paceRatio: null,
      resetsAt: null,
      resetLabel: null,
      expiresAt: null,
      burnDownBonus: 0
    }
  ]
}

export const samplePendingTasks: PendingTask[] = [
  {
    taskId: '#T1',
    domain: 'TennisClubManagement',
    projectId: 'proj-tcm',
    workspaceId: null,
    track: 'track2',
    worktreeMode: 'new',
    worktreeName: 'desk-tcm-tier-race',
    title: '티어 대진표 동시성 락 검증 및 회귀 테스트 추가',
    spec: '티어 대진표 동시성 락을 검증하고 회귀 테스트를 추가한 뒤 테스트 결과를 보고하라.',
    selectedModelId: 'codex/gpt-6-astra:high',
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    billingType: 'subscription',
    estimatedCostUsd: 0,
    estimatedMinutes: 15,
    reason: 'Codex 주간 9% 여유 / Antigravity Gemini 주간 53% 우회',
    oneLine: 'codex / gpt-6-astra (high) · Track 2 · 새 워크트리 · 구독 $0',
    options: sampleOptions,
    createdAt: 1_795_280_000_000
  }
]

export const sampleWorkers: WorkerItem[] = [
  {
    id: 'ws-tcm-01',
    taskId: '#T4',
    workspaceId: 'ws-tcm-01',
    domain: 'TennisClubManagement',
    projectId: 'proj-tcm',
    name: 'desk-tcm-checkin-card',
    branch: 'desk-tcm-checkin-card',
    track: 'Track 2',
    modelLabel: 'antigravity/claude-sonnet-5-5-high',
    status: 'done',
    unread: true,
    terminalCount: 1,
    lastActivityAt: 1_795_279_900_000,
    isDeskOwned: true,
    isActive: true
  },
  {
    id: 'ws-obs-01',
    taskId: '#T5',
    workspaceId: 'ws-obs-01',
    domain: 'ObsidianAutomation',
    projectId: 'proj-obs',
    name: 'desk-obs-dedup',
    branch: 'desk-obs-dedup',
    track: 'Track 2',
    modelLabel: 'codex/gpt-6-astra:high',
    status: 'working',
    unread: false,
    terminalCount: 1,
    lastActivityAt: 1_795_279_960_000,
    isDeskOwned: true,
    isActive: true
  },
  {
    id: 'ws-other-idle',
    taskId: null,
    workspaceId: 'ws-other-idle',
    domain: 'TennisClubManagement',
    projectId: 'proj-tcm',
    name: 'legacy-manual-branch',
    branch: 'feat/manual-legacy',
    track: 'Track 2',
    modelLabel: null,
    status: 'inactive',
    unread: false,
    terminalCount: 0,
    lastActivityAt: 1_795_100_000_000,
    isDeskOwned: false,
    isActive: false
  }
]

export const readyConsoleState: ConsoleState = {
  status: 'ready',
  instanceId: 'test-worker',
  revision: 1,
  advisorScriptPath: DEFAULT_ADVISOR_SCRIPT_PATH,
  pendingQueuePath: DEFAULT_PENDING_QUEUE_PATH,
  advisor: liveAdvisorPayload,
  pending: samplePendingTasks,
  workers: sampleWorkers,
  domains: ['전체', 'TennisClubManagement', 'ObsidianAutomation'],
  error: null,
  lastAttemptAt: 1_795_280_000_000,
  lastSuccessAt: 1_795_280_000_000,
  refreshing: false
}

export const unavailableQuotaConsoleState: ConsoleState = {
  ...readyConsoleState,
  revision: 2,
  advisor: unavailableQuotaAdvisorPayload,
  pending: []
}

export const fallbackConsoleState: ConsoleState = {
  ...readyConsoleState,
  revision: 2,
  advisor: codex429AdvisorPayload
}

export const newSubConsoleState: ConsoleState = {
  ...readyConsoleState,
  revision: 3,
  advisor: newSubAdvisorPayload
}

export const expiringConsoleState: ConsoleState = {
  ...readyConsoleState,
  revision: 4,
  advisor: expiringAdvisorPayload
}

export const staleConsoleState: ConsoleState = {
  ...readyConsoleState,
  status: 'stale',
  revision: 5,
  error: 'route-advisor 실행 시간이 초과되었습니다.'
}

export const errorConsoleState: ConsoleState = {
  status: 'error',
  instanceId: 'test-worker',
  revision: 6,
  advisorScriptPath: DEFAULT_ADVISOR_SCRIPT_PATH,
  pendingQueuePath: DEFAULT_PENDING_QUEUE_PATH,
  advisor: null,
  pending: [],
  workers: [],
  domains: ['전체'],
  error: 'route-advisor 스크립트를 찾을 수 없습니다.',
  lastAttemptAt: 1_795_280_000_000,
  lastSuccessAt: null,
  refreshing: false
}
