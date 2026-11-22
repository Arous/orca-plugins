import { randomUUID } from 'node:crypto'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { buildA2UISurfacePayload } from './a2ui'
import {
  collectAdvisor,
  defaultCommandRunner,
  type AdvisorCollectResult,
  type CommandRunner
} from './advisor'
import { consoleStatusTone, formatTaskCost, statusBarText, statusBarTooltip } from './format'
import {
  DEFAULT_ADVISOR_SCRIPT_PATH,
  DEFAULT_POLL_SECONDS,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  type AdvisorRecommendation,
  type ApproveTaskInput,
  type CancelTaskInput,
  type ConsoleState,
  type HandoffTaskInput,
  type ModelOption,
  type OpenWorkspaceInput,
  type OverrideModelInput,
  type PendingTask,
  type WorkerBoardStatus,
  type WorkerItem
} from './protocol'

const STORAGE_PENDING_KEY = 'intake-desk-console.pending'
const STORAGE_WORKERS_KEY = 'intake-desk-console.workers'
const STORAGE_DISMISSED_KEY = 'intake-desk-console.dismissed'
const CLI_TIMEOUT_MS = 15_000

export type AdvisorCollector = (
  scriptPath: string,
  signal: AbortSignal
) => Promise<AdvisorCollectResult>

export type RuntimeDeps = {
  collectAdvisor?: AdvisorCollector
  runCommand?: CommandRunner
  now?: () => number
}

export type RuntimeSettings = {
  advisorScriptPath: string
  pollSeconds: number
}

export type ConsoleRuntime = {
  start(): Promise<void>
  stop(): void
  refresh(): Promise<ConsoleState>
  reloadSettings(): Promise<void>
  state(): ConsoleState
}

type Disposable = { dispose(): void }

type ProjectRow = {
  id: string
  name: string
  kind: 'git' | 'folder'
  hostId: string | null
  path: string
  hidden?: boolean
}

type WorkspaceRow = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  projectId?: string | null
  path: string
  branch: string | null
  hostId: string | null
  status?: {
    state: 'working' | 'permission' | 'done' | 'active' | 'inactive'
    unread: boolean
    terminalCount: number
    lastActivityAt: number | null
  }
}

function initialState(advisorScriptPath: string, instanceId: string): ConsoleState {
  return {
    status: 'loading',
    instanceId,
    revision: 0,
    advisorScriptPath,
    advisor: null,
    pending: [],
    workers: [],
    domains: ['전체'],
    error: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    refreshing: false
  }
}

async function readSettings(orca: OrcaWorkerApi): Promise<RuntimeSettings> {
  const values = await orca.settings.get()
  const pathValue = values.advisorScriptPath
  const pollValue = values.pollSeconds
  const advisorScriptPath =
    typeof pathValue === 'string' && pathValue.trim()
      ? pathValue.trim()
      : DEFAULT_ADVISOR_SCRIPT_PATH
  const candidate =
    typeof pollValue === 'number' && Number.isFinite(pollValue)
      ? Math.round(pollValue)
      : DEFAULT_POLL_SECONDS
  return {
    advisorScriptPath,
    pollSeconds: Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, candidate))
  }
}

function formatModelId(agent: string, model: string, effort: string): string {
  return effort ? `${agent}/${model}:${effort}` : `${agent}/${model}`
}

function parseModelId(modelId: string): { agent: string; model: string; effort: string } {
  const slash = modelId.indexOf('/')
  const agent = slash > 0 ? modelId.slice(0, slash) : 'codex'
  const rest = slash > 0 ? modelId.slice(slash + 1) : modelId
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    return { agent, model: rest.slice(0, colon), effort: rest.slice(colon + 1) || 'medium' }
  }
  return { agent, model: rest, effort: 'medium' }
}

function buildOptionsFromRecommendation(rec: AdvisorRecommendation): ModelOption[] {
  const seen = new Set<string>()
  const options: ModelOption[] = []

  const pushOption = (entry: {
    routeId: string
    shortAlias: string
    agent: string
    model: string
    effort: string
    billingType: 'subscription' | 'payg'
    costUsd: number
  }) => {
    const modelId = formatModelId(entry.agent, entry.model, entry.effort)
    if (seen.has(modelId)) return
    seen.add(modelId)
    options.push({
      modelId,
      routeId: entry.routeId,
      shortAlias: entry.shortAlias,
      agent: entry.agent,
      model: entry.model,
      effort: entry.effort,
      billingType: entry.billingType,
      label: `${entry.agent} / ${entry.model} (${entry.effort}) · ${formatTaskCost(entry.billingType, entry.costUsd)}`
    })
  }

  pushOption({
    routeId: rec.routeId,
    shortAlias: rec.agent,
    agent: rec.agent,
    model: rec.model,
    effort: rec.effort,
    billingType: rec.billingType,
    costUsd: rec.estimatedCostUsd
  })

  for (const alt of rec.alternatives) {
    pushOption({
      routeId: alt.routeId,
      shortAlias: alt.shortAlias,
      agent: alt.agent,
      model: alt.model,
      effort: alt.effort,
      billingType: alt.billingType,
      costUsd: alt.billingType === 'subscription' ? 0 : 0.08
    })
  }

  return options
}

function findMatchingWorkspace(
  workspaces: WorkspaceRow[],
  target: string | null | undefined
): WorkspaceRow | null {
  const normalized = target?.trim().replace(/[\\/]+$/, '')
  if (!normalized) return null
  return (
    workspaces.find((ws) => {
      if (ws.name === normalized || ws.branch === normalized) return true
      const wsPath = ws.path.replace(/[\\/]+$/, '')
      return (
        wsPath === normalized ||
        wsPath.endsWith(`/${normalized}`) ||
        wsPath.endsWith(`\\${normalized}`)
      )
    }) ?? null
  )
}

function recommendationToPendingTask(
  rec: AdvisorRecommendation,
  projects: ProjectRow[],
  workspaces: WorkspaceRow[],
  nowMs: number
): PendingTask {
  const slug = rec.taskId.replace(/[^a-zA-Z0-9_-]+/g, '').toLowerCase() || 'task'
  const matchedWorkspace =
    rec.worktreeMode === 'existing' ? findMatchingWorkspace(workspaces, rec.worktree) : null
  const matchedProject = matchedWorkspace?.projectId
    ? projects.find((p) => p.id === matchedWorkspace.projectId) ?? null
    : null
  const defaultProject = matchedProject ?? projects[0] ?? null
  const options = buildOptionsFromRecommendation(rec)
  const primary = options[0]
  const fallbackWorktreeName = rec.worktree?.trim() || `desk-${slug}`
  return {
    taskId: rec.taskId,
    domain: matchedProject?.name ?? matchedWorkspace?.project ?? defaultProject?.name ?? 'Intake Desk',
    projectId: matchedWorkspace?.projectId ?? defaultProject?.id ?? null,
    workspaceId: matchedWorkspace?.id ?? null,
    track: rec.track,
    worktreeMode: rec.worktreeMode,
    worktreeName: matchedWorkspace?.name ?? fallbackWorktreeName,
    title: rec.oneLine || `${rec.taskId} 라우팅 승인`,
    selectedModelId: primary?.modelId ?? formatModelId(rec.agent, rec.model, rec.effort),
    agent: rec.agent,
    model: rec.model,
    effort: rec.effort,
    billingType: rec.billingType,
    estimatedCostUsd: rec.estimatedCostUsd,
    estimatedMinutes: rec.estimatedMinutes,
    reason: rec.reason,
    oneLine: rec.oneLine,
    options,
    createdAt: nowMs
  }
}

function mapWorkspaceState(
  state: NonNullable<WorkspaceRow['status']>['state'] | undefined,
  localStatus?: WorkerBoardStatus
): WorkerBoardStatus {
  if (localStatus === 'handoff' && (!state || state === 'inactive' || state === 'active')) {
    return 'handoff'
  }
  return state ?? localStatus ?? 'active'
}

function mergeWorkersAndDomains(
  projects: ProjectRow[],
  workspaces: WorkspaceRow[],
  localWorkers: WorkerItem[]
): { workers: WorkerItem[]; domains: string[] } {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const localByKey = new Map<string, WorkerItem>()
  for (const worker of localWorkers) {
    if (worker.workspaceId) localByKey.set(`ws:${worker.workspaceId}`, worker)
    localByKey.set(`name:${worker.name}`, worker)
  }

  const merged: WorkerItem[] = []
  const seenLocalIds = new Set<string>()

  for (const ws of workspaces) {
    if (ws.kind !== 'worktree') continue
    const project = ws.projectId ? projectById.get(ws.projectId) : undefined
    if (project?.hidden) continue
    const localMatch = localByKey.get(`ws:${ws.id}`) ?? localByKey.get(`name:${ws.name}`)
    if (localMatch) seenLocalIds.add(localMatch.id)

    const domain = project?.name ?? ws.project ?? localMatch?.domain ?? '기타'
    merged.push({
      id: ws.id,
      taskId: localMatch?.taskId ?? null,
      workspaceId: ws.id,
      domain,
      projectId: ws.projectId ?? localMatch?.projectId ?? null,
      name: ws.name,
      branch: ws.branch,
      track: localMatch?.track ?? 'Track 2',
      modelLabel: localMatch?.modelLabel ?? null,
      status: mapWorkspaceState(ws.status?.state, localMatch?.status),
      unread: ws.status?.unread ?? false,
      terminalCount: ws.status?.terminalCount ?? 0,
      lastActivityAt: ws.status?.lastActivityAt ?? localMatch?.lastActivityAt ?? null
    })
  }

  for (const local of localWorkers) {
    if (seenLocalIds.has(local.id)) continue
    merged.unshift(local)
  }

  const domainSet = new Set<string>()
  for (const worker of merged) {
    domainSet.add(worker.domain)
  }

  return {
    workers: merged,
    domains: ['전체', ...Array.from(domainSet)]
  }
}

function readStoredArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : []
}

function withErrorCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * Worker state machine for Intake Desk Console. Separates advisor execution, workspace polling,
 * and action dispatch so tests can inject a collector, command runner, and clock.
 */
export function createRuntime(orca: OrcaWorkerApi, deps: RuntimeDeps = {}): ConsoleRuntime {
  const runCommand = deps.runCommand ?? defaultCommandRunner
  const collect =
    deps.collectAdvisor ??
    ((scriptPath: string, signal: AbortSignal) => collectAdvisor(scriptPath, signal, runCommand))
  const now = deps.now ?? Date.now
  const instanceId = randomUUID()
  const disposables: Disposable[] = []

  let settings: RuntimeSettings = {
    advisorScriptPath: DEFAULT_ADVISOR_SCRIPT_PATH,
    pollSeconds: DEFAULT_POLL_SECONDS
  }
  let state = initialState(settings.advisorScriptPath, instanceId)
  let revision = 0
  let pendingQueue: PendingTask[] = []
  let localWorkers: WorkerItem[] = []
  let dismissedTaskIds = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let settingsRequest = 0
  let inFlight: Promise<ConsoleState> | null = null
  let controller: AbortController | null = null
  let stopped = false
  let settingsReady = false
  let failures = 0

  function publish(): void {
    if (stopped) return
    orca.panels.post('console.changed', state)
    void orca.host
      .call('statusBar.update', {
        id: 'summary',
        text: statusBarText(state),
        tone: consoleStatusTone(state.status),
        tooltip: statusBarTooltip(state),
        visible: true
      })
      .catch(() => {})
  }

  async function persist(): Promise<void> {
    await Promise.all([
      orca.storage.set(STORAGE_PENDING_KEY, pendingQueue as unknown as JsonValue),
      orca.storage.set(STORAGE_WORKERS_KEY, localWorkers as unknown as JsonValue),
      orca.storage.set(
        STORAGE_DISMISSED_KEY,
        Array.from(dismissedTaskIds) as unknown as JsonValue
      )
    ]).catch(() => {})
  }

  async function loadStorage(): Promise<void> {
    try {
      const [pendingRaw, workersRaw, dismissedRaw] = await Promise.all([
        orca.storage.get(STORAGE_PENDING_KEY),
        orca.storage.get(STORAGE_WORKERS_KEY),
        orca.storage.get(STORAGE_DISMISSED_KEY)
      ])
      pendingQueue = readStoredArray<PendingTask>(pendingRaw)
      localWorkers = readStoredArray<WorkerItem>(workersRaw)
      dismissedTaskIds = new Set(readStoredArray<string>(dismissedRaw))
    } catch {
      // Storage errors should not prevent the worker from starting.
    }
  }

  function schedule(): void {
    if (stopped) return
    clearTimeout(timer)
    const backoff = failures >= 2 ? Math.min(2 ** (failures - 1), 8) : 1
    const delay = Math.min(MAX_POLL_SECONDS * 1000, settings.pollSeconds * 1000 * backoff)
    timer = setTimeout(() => {
      void refresh()
    }, delay)
    timer.unref()
  }

  function settingsFailure(keepSample: boolean): ConsoleState {
    settingsReady = false
    state = {
      ...state,
      revision: ++revision,
      status: keepSample && state.advisor ? 'stale' : 'error',
      error: '플러그인 설정을 읽지 못했습니다.',
      refreshing: false
    }
    publish()
    schedule()
    return state
  }

  function adoptSettings(next: RuntimeSettings): boolean {
    const pathChanged = next.advisorScriptPath !== settings.advisorScriptPath
    settings = next
    settingsReady = true
    state = { ...state, advisorScriptPath: next.advisorScriptPath }
    return pathChanged
  }

  async function fetchProjectsAndWorkspaces(): Promise<{
    projects: ProjectRow[]
    workspaces: WorkspaceRow[]
  }> {
    const [projRes, wsRes] = await Promise.all([
      orca.host.call('project.list').catch(() => ({ projects: [] as ProjectRow[], truncated: false })),
      orca.host
        .call('workspace.list', { includeStatus: true })
        .catch(() => ({ workspaces: [] as WorkspaceRow[], truncated: false }))
    ])
    return {
      projects: projRes.projects,
      workspaces: wsRes.workspaces
    }
  }

  async function syncWorkspacesOnly(): Promise<ConsoleState> {
    if (stopped) return state
    const { projects, workspaces } = await fetchProjectsAndWorkspaces()
    if (stopped) return state
    const { workers, domains } = mergeWorkersAndDomains(projects, workspaces, localWorkers)
    state = {
      ...state,
      revision: ++revision,
      workers,
      domains
    }
    publish()
    return state
  }

  function refresh(): Promise<ConsoleState> {
    if (stopped) return Promise.resolve(state)
    if (inFlight) return inFlight

    const run = (async (): Promise<ConsoleState> => {
      await Promise.resolve()
      if (!settingsReady) {
        const request = ++settingsRequest
        try {
          const next = await readSettings(orca)
          if (stopped || request !== settingsRequest) {
            if (!stopped) schedule()
            return state
          }
          adoptSettings(next)
        } catch {
          if (stopped || request !== settingsRequest) {
            if (!stopped) schedule()
            return state
          }
          return settingsFailure(Boolean(state.advisor))
        }
      }

      clearTimeout(timer)
      const scriptPath = settings.advisorScriptPath
      const attemptAt = now()
      state = {
        ...state,
        advisorScriptPath: scriptPath,
        revision: ++revision,
        refreshing: true,
        lastAttemptAt: attemptAt
      }
      publish()

      const current = new AbortController()
      controller = current

      try {
        const [advisorResult, hostSnapshot] = await Promise.all([
          collect(scriptPath, current.signal),
          fetchProjectsAndWorkspaces()
        ])
        if (stopped || !settingsReady || settings.advisorScriptPath !== scriptPath) {
          return state
        }

        const { workers, domains } = mergeWorkersAndDomains(
          hostSnapshot.projects,
          hostSnapshot.workspaces,
          localWorkers
        )

        if (advisorResult.ok) {
          const payload = advisorResult.payload
          const rec = payload.recommendation
          if (
            rec &&
            !pendingQueue.some((p) => p.taskId === rec.taskId) &&
            !localWorkers.some((w) => w.taskId === rec.taskId) &&
            !dismissedTaskIds.has(rec.taskId)
          ) {
            pendingQueue = [
              recommendationToPendingTask(
                rec,
                hostSnapshot.projects,
                hostSnapshot.workspaces,
                now()
              ),
              ...pendingQueue
            ]
            await persist()
          }
          const at = now()
          failures = 0
          state = {
            status: 'ready',
            instanceId,
            revision: ++revision,
            advisorScriptPath: scriptPath,
            advisor: payload,
            pending: pendingQueue,
            workers,
            domains,
            error: null,
            lastAttemptAt: attemptAt,
            lastSuccessAt: at,
            refreshing: false
          }
        } else {
          failures += 1
          state = {
            ...state,
            revision: ++revision,
            advisorScriptPath: scriptPath,
            status: state.advisor ? 'stale' : 'error',
            pending: pendingQueue,
            workers,
            domains,
            error: advisorResult.error,
            lastAttemptAt: attemptAt,
            refreshing: false
          }
        }
      } catch {
        if (stopped) return state
        failures += 1
        state = {
          ...state,
          revision: ++revision,
          status: state.advisor ? 'stale' : 'error',
          error: 'Intake Desk 상태를 갱신하지 못했습니다.',
          refreshing: false
        }
      } finally {
        if (controller === current) controller = null
        if (!stopped && settings.advisorScriptPath === scriptPath) {
          publish()
          schedule()
        }
      }
      return state
    })()

    inFlight = run
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  }

  function applyModelOverride(task: PendingTask, modelId: string): PendingTask {
    const matched = task.options.find((opt) => opt.modelId === modelId)
    if (matched) {
      return {
        ...task,
        selectedModelId: matched.modelId,
        agent: matched.agent,
        model: matched.model,
        effort: matched.effort,
        billingType: matched.billingType
      }
    }
    const parsed = parseModelId(modelId)
    return {
      ...task,
      selectedModelId: modelId,
      agent: parsed.agent,
      model: parsed.model,
      effort: parsed.effort
    }
  }

  async function overrideModel(input: OverrideModelInput): Promise<ConsoleState> {
    const idx = pendingQueue.findIndex((p) => p.taskId === input.taskId)
    if (idx === -1) throw withErrorCode(`대기 작업 ${input.taskId}를 찾을 수 없습니다.`, 'invalid_params')

    pendingQueue = pendingQueue.map((task, index) =>
      index === idx ? applyModelOverride(task, input.modelId) : task
    )
    await persist()
    state = {
      ...state,
      revision: ++revision,
      pending: pendingQueue
    }
    publish()
    return state
  }

  async function dispatchTask(
    input: ApproveTaskInput | HandoffTaskInput,
    forceTrack3: boolean
  ): Promise<ConsoleState> {
    const idx = pendingQueue.findIndex((p) => p.taskId === input.taskId)
    if (idx === -1) throw withErrorCode(`대기 작업 ${input.taskId}를 찾을 수 없습니다.`, 'invalid_params')

    let task = pendingQueue[idx]
    if (input.modelId) {
      task = applyModelOverride(task, input.modelId)
    }

    if (task.workspaceId) {
      if (forceTrack3) {
        await orca.host.call('workspace.open', { workspaceId: task.workspaceId })
      }
      await orca.host.call('agent.launch', {
        workspaceId: task.workspaceId,
        agent: task.agent,
        prompt: task.title
      })
    } else {
      const cliArgs = forceTrack3
        ? [
            'worktree',
            'create',
            ...(task.projectId ? ['--repo', `id:${task.projectId}`] : []),
            '--name',
            task.worktreeName,
            '--no-parent',
            '--agent',
            task.agent,
            '--model',
            task.model,
            '--effort',
            task.effort,
            '--surface',
            'chat',
            '--activate',
            '--prompt',
            task.title,
            '--json'
          ]
        : [
            'orchestration',
            'worker-start',
            '--environment',
            'local',
            '--worktree',
            'new-top-level',
            ...(task.projectId ? ['--repo', `id:${task.projectId}`] : []),
            '--name',
            task.worktreeName,
            '--agent',
            task.agent,
            '--model',
            task.model,
            '--effort',
            task.effort,
            '--spec',
            task.title,
            '--json'
          ]

      const cliController = new AbortController()
      const res = await runCommand('orca', cliArgs, {
        signal: cliController.signal,
        timeoutMs: CLI_TIMEOUT_MS
      })
      if (res.exitCode !== 0) {
        throw withErrorCode(
          res.stderr.trim() || `작업 실행에 실패했습니다 (${task.taskId}).`,
          'action_failed'
        )
      }
    }

    pendingQueue = pendingQueue.filter((p) => p.taskId !== task.taskId)
    const worker: WorkerItem = {
      id: task.workspaceId ?? `worker-${task.taskId}`,
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      domain: task.domain,
      projectId: task.projectId,
      name: task.worktreeName,
      branch: task.worktreeName,
      track: forceTrack3 ? 'Track 3' : 'Track 2',
      modelLabel: task.selectedModelId,
      status: forceTrack3 ? 'handoff' : 'working',
      unread: false,
      terminalCount: 1,
      lastActivityAt: now()
    }
    localWorkers = [worker, ...localWorkers.filter((w) => w.taskId !== task.taskId)]
    await persist()

    const hostSnapshot = await fetchProjectsAndWorkspaces()
    const { workers, domains } = mergeWorkersAndDomains(
      hostSnapshot.projects,
      hostSnapshot.workspaces,
      localWorkers
    )

    state = {
      ...state,
      revision: ++revision,
      pending: pendingQueue,
      workers,
      domains
    }
    publish()

    void orca.host
      .call('notifications.show', {
        title: `Intake Desk ${task.taskId}`,
        body: `${forceTrack3 ? '직접 열기' : '승인 실행'} · ${task.selectedModelId}`
      })
      .catch(() => {})

    return state
  }

  async function cancelTask(input: CancelTaskInput): Promise<ConsoleState> {
    const idx = pendingQueue.findIndex((p) => p.taskId === input.taskId)
    if (idx === -1) throw withErrorCode(`대기 작업 ${input.taskId}를 찾을 수 없습니다.`, 'invalid_params')

    pendingQueue = pendingQueue.filter((p) => p.taskId !== input.taskId)
    dismissedTaskIds.add(input.taskId)
    await persist()
    state = {
      ...state,
      revision: ++revision,
      pending: pendingQueue
    }
    publish()
    return state
  }

  async function openWorkspace(input: OpenWorkspaceInput): Promise<ConsoleState> {
    if (!input.workspaceId) {
      throw withErrorCode('열 수 있는 워크스페이스 ID가 없습니다.', 'invalid_params')
    }
    await orca.host.call('workspace.open', { workspaceId: input.workspaceId })
    return state
  }

  async function reloadSettings(): Promise<void> {
    if (stopped) return
    const request = ++settingsRequest
    let next: RuntimeSettings
    try {
      next = await readSettings(orca)
    } catch {
      if (stopped || request !== settingsRequest) return
      settingsFailure(Boolean(state.advisor))
      return
    }
    if (stopped || request !== settingsRequest) return
    const intervalChanged = next.pollSeconds !== settings.pollSeconds
    const pathChanged = adoptSettings(next)
    if (pathChanged) {
      const pending = inFlight
      controller?.abort()
      clearTimeout(timer)
      if (pending) await pending.catch(() => undefined)
      if (!stopped) void refresh()
      return
    }
    if (intervalChanged) {
      clearTimeout(timer)
      schedule()
    }
    if (state.status !== 'ready' && !inFlight) {
      void refresh()
    }
  }

  async function start(): Promise<void> {
    stopped = false
    await loadStorage()

    disposables.push(orca.panels.handle('console.get', () => state))
    disposables.push(orca.panels.handle('console.refresh', () => refresh()))
    disposables.push(
      orca.panels.handle('console.overrideModel', (input) => overrideModel(input))
    )
    disposables.push(
      orca.panels.handle('console.approve', (input) => dispatchTask(input, false))
    )
    disposables.push(
      orca.panels.handle('console.handoff', (input) => dispatchTask(input, true))
    )
    disposables.push(orca.panels.handle('console.cancel', (input) => cancelTask(input)))
    disposables.push(
      orca.panels.handle('console.openWorkspace', (input) => openWorkspace(input))
    )
    disposables.push(
      orca.panels.handle('console.a2uiSnapshot', () => buildA2UISurfacePayload(state))
    )

    disposables.push(
      orca.commands.register('refresh', async () => {
        const next = await refresh()
        return statusBarText(next)
      })
    )

    for (const eventName of [
      'agent.status.changed',
      'workspace.created',
      'workspace.removed',
      'workspace.changed'
    ] as const) {
      disposables.push(
        orca.events.on(eventName, () => syncWorkspacesOnly().then(() => undefined))
      )
    }

    disposables.push(
      orca.settings.onDidChange(() => {
        void reloadSettings().catch(() =>
          orca.log('Intake Desk Console: settings reload failed')
        )
      })
    )

    const request = ++settingsRequest
    try {
      const next = await readSettings(orca)
      if (stopped || request !== settingsRequest) {
        if (!stopped) schedule()
        return
      }
      adoptSettings(next)
    } catch {
      if (stopped || request !== settingsRequest) {
        if (!stopped) schedule()
        return
      }
      settingsFailure(false)
      return
    }

    if (stopped) return
    publish()
    void refresh()
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
    controller?.abort()
    controller = null
    inFlight = null
    for (const disposable of disposables.splice(0)) disposable.dispose()
  }

  return {
    start,
    stop,
    refresh,
    reloadSettings,
    state: () => state
  }
}

let runtime: ConsoleRuntime | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  runtime = createRuntime(orca)
  await runtime.start()
}

export function deactivate(): void {
  runtime?.stop()
  runtime = null
}
