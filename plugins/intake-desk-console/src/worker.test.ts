import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import {
  codex429AdvisorPayload,
  liveAdvisorPayload,
  samplePendingTasks
} from './fixtures'
import type { ConsoleState } from './protocol'
import { createRuntime } from './worker'

type StatusBarCall = {
  id: string
  text?: string
  tone?: string
  tooltip?: string
  visible?: boolean
}

function fakeOrca(options: {
  settings?: Record<string, unknown>
  failSettings?: boolean
  storage?: Record<string, unknown>
  projects?: { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string; hidden?: boolean }[]
  workspaces?: {
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
  }[]
} = {}) {
  const settings: Record<string, unknown> = {
    advisorScriptPath: '~/.orca/bots/intake-desk/scripts/route-advisor.mjs',
    pollSeconds: 30,
    ...options.settings
  }
  let settingsUnavailable = Boolean(options.failSettings)
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}))
  const handlers = new Map<string, (input?: unknown) => unknown>()
  const eventHandlers = new Map<string, Array<(payload: unknown) => unknown>>()
  const posts: ConsoleState[] = []
  const statusBar: StatusBarCall[] = []
  const hostCalls: Array<{ method: string; params: unknown }> = []
  const logs: string[] = []
  const settingsListeners: Array<(change: { key: string }) => void> = []
  const disposable = { dispose() {} }

  const projects = options.projects ?? [
    { id: 'proj-tcm', name: 'TennisClubManagement', kind: 'git' as const, hostId: 'local', path: '/repo/tcm' },
    { id: 'proj-obs', name: 'ObsidianAutomation', kind: 'git' as const, hostId: 'local', path: '/repo/obs' }
  ]
  const workspaces = options.workspaces ?? [
    {
      id: 'ws-tcm-01',
      kind: 'worktree' as const,
      name: 'desk-tcm-checkin-card',
      project: 'TennisClubManagement',
      projectId: 'proj-tcm',
      path: '/wt/desk-tcm-checkin-card',
      branch: 'desk-tcm-checkin-card',
      hostId: 'local',
      status: { state: 'done' as const, unread: true, terminalCount: 1, lastActivityAt: 1_795_279_900_000 }
    },
    {
      id: 'ws-obs-01',
      kind: 'worktree' as const,
      name: 'desk-obs-dedup',
      project: 'ObsidianAutomation',
      projectId: 'proj-obs',
      path: '/wt/desk-obs-dedup',
      branch: 'desk-obs-dedup',
      hostId: 'local',
      status: { state: 'working' as const, unread: false, terminalCount: 1, lastActivityAt: 1_795_279_960_000 }
    }
  ]

  const orca = {
    api: { major: 1, minor: 10 },
    commands: {
      register: (id: string, handler: (args: unknown, context: unknown) => unknown) => {
        handlers.set(`command:${id}`, (args) => handler(args, { signal: new AbortController().signal }))
        return disposable
      }
    },
    events: {
      on: (event: string, handler: (payload: unknown) => unknown) => {
        const list = eventHandlers.get(event) ?? []
        list.push(handler)
        eventHandlers.set(event, list)
        return disposable
      }
    },
    hooks: { on: () => disposable },
    host: {
      has: () => true,
      call: async (method: string, params: unknown) => {
        hostCalls.push({ method, params })
        if (method === 'statusBar.update') {
          statusBar.push(params as StatusBarCall)
          return { ok: true }
        }
        if (method === 'project.list') return { projects, truncated: false }
        if (method === 'workspace.list') return { workspaces, truncated: false }
        if (method === 'workspace.open') return { opened: true }
        if (method === 'agent.launch') return { terminalId: 'term-99' }
        if (method === 'notifications.show') return { delivered: true }
        return { ok: true }
      }
    },
    panels: {
      handle: (name: string, handler: (input?: unknown) => unknown) => {
        handlers.set(name, handler)
        return disposable
      },
      post: (event: string, payload: ConsoleState) => {
        if (event === 'console.changed') posts.push(payload)
      }
    },
    storage: {
      get: async (key: string) => (storage.has(key) ? storage.get(key) : null),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      delete: async (key: string) => {
        storage.delete(key)
      },
      keys: async () => Array.from(storage.keys()),
      onDidChange: () => disposable
    },
    settings: {
      get: async (key?: string) => {
        if (settingsUnavailable) throw new Error('settings unavailable')
        return key === undefined ? { ...settings } : settings[key]
      },
      set: async (key: string, value: unknown) => {
        settings[key] = value
      },
      onDidChange: (listener: (change: { key: string }) => void) => {
        settingsListeners.push(listener)
        return disposable
      }
    },
    secrets: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    },
    grantedCapabilities: [
      'workspace:read',
      'workspace:write',
      'agent:read',
      'agent:launch',
      'terminal:send',
      'notifications:show',
      'storage:own',
      'settings:own'
    ],
    log: (message: string) => logs.push(message)
  } as unknown as OrcaWorkerApi

  return {
    orca,
    settings,
    storage,
    handlers,
    eventHandlers,
    posts,
    statusBar,
    hostCalls,
    workspaces,
    setSettingsFailure: (value: boolean) => {
      settingsUnavailable = value
    },
    emitEvent: async (event: string, payload: unknown) => {
      for (const listener of eventHandlers.get(event) ?? []) {
        await listener(payload)
      }
    }
  }
}

test('collects advisor, workspaces, and projects into ready ConsoleState and updates statusBar', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.advisor?.deskModel.active, 'openai-codex/gpt-6.2-astra')
    assert.equal(state.pending.length, 1)
    assert.equal(state.pending[0]?.taskId, '#T1')
    assert.equal(state.workers.length, 2)
    assert.deepEqual(state.domains, ['전체', 'TennisClubManagement', 'ObsidianAutomation'])
    assert.equal(fake.statusBar.at(-1)?.text, 'Desk 대기 1 · 워커 2')
    assert.equal(fake.statusBar.at(-1)?.tone, 'success')
    assert.deepEqual(fake.handlers.get('console.get')?.(), state)
  } finally {
    runtime.stop()
  }
})

test('preserves last advisor snapshot as stale when a subsequent advisor collection fails', async () => {
  const fake = fakeOrca()
  let shouldFail = false
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () =>
      shouldFail
        ? { ok: false, code: 'timeout', error: 'route-advisor 실행 시간이 초과되었습니다.', payload: null }
        : { ok: true, payload: liveAdvisorPayload },
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    shouldFail = true
    const stale = await runtime.refresh()
    assert.equal(stale.status, 'stale')
    assert.ok(stale.advisor)
    assert.equal(stale.workers.length, 2)
    assert.equal(stale.error, 'route-advisor 실행 시간이 초과되었습니다.')
    assert.equal(fake.statusBar.at(-1)?.tone, 'warning')
  } finally {
    runtime.stop()
  }
})

test('reports error while keeping worker board when no advisor snapshot ever succeeded', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({
      ok: false,
      code: 'missing-script',
      error: 'route-advisor 스크립트를 찾을 수 없습니다.',
      payload: null
    }),
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.advisor, null)
    assert.equal(state.workers.length, 2)
    assert.equal(fake.statusBar.at(-1)?.text, 'Desk 오류')
    assert.equal(fake.statusBar.at(-1)?.tone, 'danger')
  } finally {
    runtime.stop()
  }
})

test('handles overrideModel, approve, handoff, cancel, openWorkspace, and a2uiSnapshot panel RPCs', async () => {
  const commandCalls: Array<{ cmd: string; args: string[] }> = []
  const fake = fakeOrca({
    storage: {
      'intake-desk-console.pending': samplePendingTasks
    }
  })
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: codex429AdvisorPayload }),
    runCommand: async (cmd, args) => {
      commandCalls.push({ cmd, args })
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()

    // overrideModel
    const overrideHandler = fake.handlers.get('console.overrideModel')
    assert.ok(overrideHandler)
    const overridden = (await overrideHandler({
      taskId: '#T1',
      modelId: 'antigravity/claude-sonnet-5-5-high:high'
    })) as ConsoleState
    assert.equal(overridden.pending[0]?.selectedModelId, 'antigravity/claude-sonnet-5-5-high:high')
    assert.equal(overridden.pending[0]?.agent, 'antigravity')

    // approve (new worktree -> worker-start via runCommand)
    const approveHandler = fake.handlers.get('console.approve')
    assert.ok(approveHandler)
    const approved = (await approveHandler({ taskId: '#T1' })) as ConsoleState
    assert.equal(approved.pending.length, 0)
    assert.ok(approved.workers.some((w) => w.taskId === '#T1' && w.status === 'working'))
    assert.ok(commandCalls.some((c) => c.args.includes('worker-start')))

    // openWorkspace
    const openHandler = fake.handlers.get('console.openWorkspace')
    assert.ok(openHandler)
    await openHandler({ workspaceId: 'ws-tcm-01' })
    assert.ok(
      fake.hostCalls.some(
        (c) => c.method === 'workspace.open' && (c.params as { workspaceId: string }).workspaceId === 'ws-tcm-01'
      )
    )

    // a2uiSnapshot
    const a2uiHandler = fake.handlers.get('console.a2uiSnapshot')
    assert.ok(a2uiHandler)
    const a2ui = (await a2uiHandler()) as Array<{ version: string }>
    assert.equal(a2ui.length, 3)
    assert.equal(a2ui[0]?.version, '1.0')
  } finally {
    runtime.stop()
  }
})

test('handles handoff (Track 3) and cancel actions cleanly', async () => {
  const commandCalls: Array<{ cmd: string; args: string[] }> = []
  const fake = fakeOrca({
    storage: {
      'intake-desk-console.pending': [
        samplePendingTasks[0],
        { ...samplePendingTasks[0], taskId: '#T2', worktreeName: 'desk-obs-smoke' }
      ]
    }
  })
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: { ...liveAdvisorPayload, recommendation: null } }),
    runCommand: async (cmd, args) => {
      commandCalls.push({ cmd, args })
      return { exitCode: 0, stdout: '{"workspaceId":"ws-new"}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()

    const handoffHandler = fake.handlers.get('console.handoff')!
    const handedOff = (await handoffHandler({ taskId: '#T1' })) as ConsoleState
    assert.ok(handedOff.workers.some((w) => w.taskId === '#T1' && w.status === 'handoff'))
    assert.ok(commandCalls.some((c) => c.args.includes('create') && c.args.includes('--activate')))

    const cancelHandler = fake.handlers.get('console.cancel')!
    const cancelled = (await cancelHandler({ taskId: '#T2' })) as ConsoleState
    assert.equal(cancelled.pending.length, 0)
  } finally {
    runtime.stop()
  }
})

test('refreshes workspace board when workspace or agent status events arrive', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    fake.workspaces.push({
      id: 'ws-bots-03',
      kind: 'worktree',
      name: 'desk-bots-probe',
      project: 'orca-bots',
      projectId: 'proj-bots',
      path: '/wt/desk-bots-probe',
      branch: 'desk-bots-probe',
      hostId: 'local',
      status: { state: 'permission', unread: true, terminalCount: 1, lastActivityAt: 1_795_280_010_000 }
    })

    await fake.emitEvent('agent.status.changed', {
      workspaceId: 'ws-bots-03',
      paneKey: 'pane-1',
      state: 'waiting',
      receivedAt: 1_795_280_010_000
    })

    const current = runtime.state()
    assert.equal(current.workers.length, 3)
    assert.ok(current.workers.some((w) => w.workspaceId === 'ws-bots-03' && w.status === 'permission'))
  } finally {
    runtime.stop()
  }
})

test('handles settings read failure via single settingsFailure transition and recovers on retry', async () => {
  const fake = fakeOrca({ failSettings: true })
  let advisorCalls = 0
  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => {
      advisorCalls += 1
      return { ok: true, payload: liveAdvisorPayload }
    },
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    assert.equal(runtime.state().status, 'error')
    assert.equal(runtime.state().error, '플러그인 설정을 읽지 못했습니다.')
    assert.equal(advisorCalls, 0)
    assert.equal(fake.statusBar.at(-1)?.tone, 'danger')

    fake.setSettingsFailure(false)
    const recovered = await runtime.refresh()
    assert.equal(recovered.status, 'ready')
    assert.equal(advisorCalls, 1)

    fake.setSettingsFailure(true)
    await runtime.reloadSettings()
    assert.equal(runtime.state().status, 'stale')
    assert.equal(runtime.state().error, '플러그인 설정을 읽지 못했습니다.')
    assert.equal(fake.statusBar.at(-1)?.tone, 'warning')

    fake.setSettingsFailure(false)
    const retried = await runtime.refresh()
    assert.equal(retried.status, 'ready')
    assert.equal(advisorCalls, 2)
  } finally {
    runtime.stop()
  }
})

test('matches existing workspaceId by name, branch, or path suffix when worktreeMode is existing', async () => {
  // 1. Match by path suffix and verify approve calls agent.launch instead of worker-start CLI
  const fakeByPath = fakeOrca({
    workspaces: [
      {
        id: 'ws-obs-existing',
        kind: 'worktree',
        name: 'obs-followup',
        project: 'ObsidianAutomation',
        projectId: 'proj-obs',
        path: '/Users/test/wt/tcm-validation-followup-terra',
        branch: 'feat/followup',
        hostId: 'local',
        status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
      }
    ]
  })
  let cliCalled = false
  const runtimePath = createRuntime(fakeByPath.orca, {
    collectAdvisor: async () => ({
      ok: true,
      payload: {
        ...liveAdvisorPayload,
        recommendation: {
          ...liveAdvisorPayload.recommendation!,
          taskId: '#T10',
          track: 'track2',
          worktreeMode: 'existing',
          worktree: 'tcm-validation-followup-terra'
        }
      }
    }),
    runCommand: async () => {
      cliCalled = true
      return { exitCode: 0, stdout: '{}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await runtimePath.start()
  try {
    const refreshed = await runtimePath.refresh()
    const task = refreshed.pending.find((p) => p.taskId === '#T10')
    assert.ok(task)
    assert.equal(task.workspaceId, 'ws-obs-existing')
    assert.equal(task.domain, 'ObsidianAutomation')
    assert.equal(task.projectId, 'proj-obs')

    await fakeByPath.handlers.get('console.approve')!({ taskId: '#T10' })
    assert.equal(cliCalled, false)
    assert.ok(
      fakeByPath.hostCalls.some(
        (c) =>
          c.method === 'agent.launch' &&
          (c.params as { workspaceId: string }).workspaceId === 'ws-obs-existing'
      )
    )
  } finally {
    runtimePath.stop()
  }

  // 2. Match by branch, and keep null safely when no workspace matches
  const fakeByBranch = fakeOrca()
  const runtimeBranch = createRuntime(fakeByBranch.orca, {
    collectAdvisor: async () => ({
      ok: true,
      payload: {
        ...liveAdvisorPayload,
        recommendation: {
          ...liveAdvisorPayload.recommendation!,
          taskId: '#T11',
          worktreeMode: 'existing',
          worktree: 'desk-obs-dedup'
        }
      }
    }),
    now: () => 1_795_280_000_000
  })
  await runtimeBranch.start()
  try {
    const state = await runtimeBranch.refresh()
    assert.equal(state.pending.find((p) => p.taskId === '#T11')?.workspaceId, 'ws-obs-01')
  } finally {
    runtimeBranch.stop()
  }

  const fakeUnmatched = fakeOrca()
  const runtimeUnmatched = createRuntime(fakeUnmatched.orca, {
    collectAdvisor: async () => ({
      ok: true,
      payload: {
        ...liveAdvisorPayload,
        recommendation: {
          ...liveAdvisorPayload.recommendation!,
          taskId: '#T12',
          worktreeMode: 'existing',
          worktree: 'nonexistent-worktree'
        }
      }
    }),
    now: () => 1_795_280_000_000
  })
  await runtimeUnmatched.start()
  try {
    const state = await runtimeUnmatched.refresh()
    assert.equal(state.pending.find((p) => p.taskId === '#T12')?.workspaceId, null)
  } finally {
    runtimeUnmatched.stop()
  }
})
