import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import {
  codex429AdvisorPayload,
  liveAdvisorPayload,
  samplePendingTasks
} from './fixtures'
import type { ConsoleState, PendingQueueFileItem } from './protocol'
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
    pendingQueuePath: '/nonexistent/intake-desk-test-pending-approvals.json',
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
    },
    emitSettingsChange: (key: string) => {
      for (const listener of settingsListeners) {
        listener({ key })
      }
    }
  }
}

test('does not synthesize fake pending tasks from advisor recommendation and filters inactive non-Desk worktrees in statusBar', async () => {
  const fake = fakeOrca()
  fake.workspaces.push({
    id: 'ws-other-inactive',
    kind: 'worktree',
    name: 'legacy-manual-branch',
    project: 'TennisClubManagement',
    projectId: 'proj-tcm',
    path: '/wt/legacy-manual-branch',
    branch: 'feat/manual-legacy',
    hostId: 'local',
    status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
  })

  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.advisor?.deskModel.active, 'openai-codex/gpt-6.2-astra')
    assert.equal(state.pending.length, 0)
    assert.equal(state.workers.length, 3)
    const legacy = state.workers.find((w) => w.id === 'ws-other-inactive')
    assert.equal(legacy?.isDeskOwned, false)
    assert.equal(legacy?.isActive, false)
    assert.deepEqual(state.domains, ['전체', 'ObsidianAutomation', 'TennisClubManagement'])
    assert.equal(fake.statusBar.at(-1)?.text, 'Desk 대기 0 · 워커 2')
    assert.equal(fake.statusBar.at(-1)?.tone, 'success')
    assert.deepEqual(fake.handlers.get('console.get')?.(), state)
  } finally {
    runtime.stop()
  }
})

test('reads pending-approvals.json read-only, isolates concurrent bot appends via .handled.json ack, and allows reused #T1 with newer createdAt despite historical workers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'intake-queue-file-'))
  try {
    mkdirSync(dir, { recursive: true })
    const queuePath = join(dir, 'pending-approvals.json')
    const handledPath = join(dir, 'pending-approvals.handled.json')
    const item1: PendingQueueFileItem = {
      taskId: '#T1',
      domain: 'TennisClubManagement',
      projectId: 'proj-tcm',
      track: 'track2',
      worktreeMode: 'new',
      worktreeName: 'desk-tcm-real-queue',
      title: '대진표 테스트 보강',
      spec: 'docs와 tests를 확인해 티어 대진표 동시성 회귀 테스트를 추가하라.',
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      billingType: 'subscription',
      estimatedCostUsd: 0,
      estimatedMinutes: 15,
      reason: 'Codex 주간 9% 여유',
      oneLine: '추천 #T1',
      createdAt: 1_795_280_000_000
    }
    const rawInitial = JSON.stringify({ schemaVersion: 1, items: [item1] }, null, 2)
    writeFileSync(queuePath, rawInitial)

    // Pre-populate storage with a historical #T1 local worker (like Round 6 live storage)
    const fake = fakeOrca({
      settings: { pendingQueuePath: queuePath },
      storage: {
        'intake-desk-console.workers': [
          {
            id: 'worker-#T1',
            taskId: '#T1',
            workspaceId: null,
            domain: 'TennisClubManagement',
            projectId: 'proj-tcm',
            name: 'desk-t1',
            branch: 'desk-t1',
            track: 'Track 3',
            modelLabel: 'codex/gpt-6-astra:high',
            status: 'handoff',
            unread: false,
            terminalCount: 1,
            lastActivityAt: 1_795_270_000_000,
            isDeskOwned: true,
            isActive: true
          }
        ]
      }
    })
    const commandCalls: Array<{ cmd: string; args: string[] }> = []
    let releaseCli!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseCli = resolve
    })

    const runtime = createRuntime(fake.orca, {
      collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
      runCommand: async (cmd, args) => {
        commandCalls.push({ cmd, args })
        await gate
        return { exitCode: 0, stdout: '{"workspaceId":"ws-new-t1"}', stderr: '' }
      },
      now: () => 1_795_280_001_000
    })
    await runtime.start()
    try {
      // Historical worker with same #T1 must NOT hide a fresh queued #T1
      const state = await runtime.refresh()
      assert.equal(state.pending.length, 1)
      assert.equal(state.pending[0]?.spec, item1.spec)
      assert.equal(fake.statusBar.at(-1)?.text, 'Desk 대기 1 · 워커 3')

      // While approve is in-flight, bot concurrently appends #T2 and a future #T1 (newer createdAt)
      const approvePromise = fake.handlers.get('console.approve')!({ taskId: '#T1' })
      const item2: PendingQueueFileItem = {
        ...item1,
        taskId: '#T2',
        worktreeName: 'desk-tcm-concurrent',
        spec: '동시 추가된 #T2 작업이 덮어쓰기로 유실되지 않아야 한다.',
        createdAt: 1_795_280_000_500
      }
      const rawWithConcurrent = JSON.stringify({ schemaVersion: 1, items: [item1, item2] }, null, 2)
      writeFileSync(queuePath, rawWithConcurrent)
      releaseCli()
      await approvePromise

      assert.equal(commandCalls.length, 1)
      assert.ok(commandCalls[0]?.args.includes('path:/repo/tcm'))
      assert.ok(commandCalls[0]?.args.includes(item1.spec))

      // Plugin NEVER overwrote pending-approvals.json — concurrent #T2 is intact on disk
      assert.equal(readFileSync(queuePath, 'utf8'), rawWithConcurrent)
      const handledJson = JSON.parse(readFileSync(handledPath, 'utf8')) as {
        entries: Array<{ taskId: string; createdAt: number; action: string }>
      }
      assert.equal(handledJson.entries.length, 1)
      assert.equal(handledJson.entries[0]?.taskId, '#T1')
      assert.equal(handledJson.entries[0]?.createdAt, item1.createdAt)
      assert.equal(handledJson.entries[0]?.action, 'approved')

      // Refresh hides acked #T1@1_795_280_000_000 and picks up concurrent #T2 immediately
      const afterConcurrent = await runtime.refresh()
      assert.deepEqual(
        afterConcurrent.pending.map((p) => p.taskId),
        ['#T2']
      )

      // Later, bot reuses #T1 with a newer createdAt -> must appear cleanly
      const reusedT1: PendingQueueFileItem = {
        ...item1,
        taskId: '#T1',
        worktreeName: 'desk-tcm-reused',
        spec: '새 createdAt으로 재발급된 #T1 작업이다.',
        createdAt: 1_795_290_000_000
      }
      writeFileSync(queuePath, JSON.stringify({ schemaVersion: 1, items: [item1, item2, reusedT1] }, null, 2))
      const afterReuse = await runtime.refresh()
      assert.deepEqual(
        afterReuse.pending.map((p) => p.taskId),
        ['#T2', '#T1']
      )

      // Even if TWO concurrent #T1 instances exist with distinct createdAt, approve/cancel disambiguates exact instance
      const secondDuplicateT1: PendingQueueFileItem = {
        ...item1,
        taskId: '#T1',
        worktreeName: 'desk-tcm-dup-second',
        spec: '두 번째 동일 #T1 인스턴스만 정확히 실행되어야 한다.',
        createdAt: 1_795_295_000_000
      }
      writeFileSync(
        queuePath,
        JSON.stringify({ schemaVersion: 1, items: [reusedT1, secondDuplicateT1] }, null, 2)
      )
      const dupLoaded = await runtime.refresh()
      assert.equal(dupLoaded.pending.length, 2)

      // Bare taskId without createdAt rejects as ambiguous conflict
      let ambCode: string | undefined
      try {
        await fake.handlers.get('console.approve')!({ taskId: '#T1' })
      } catch (error) {
        ambCode = (error as { code?: string }).code
      }
      assert.equal(ambCode, 'conflict')

      // Explicit createdAt targets ONLY the second instance, leaving first instance intact
      const approvedSecond = (await fake.handlers.get('console.approve')!({
        taskId: '#T1',
        createdAt: secondDuplicateT1.createdAt
      })) as ConsoleState
      assert.equal(approvedSecond.pending.length, 1)
      assert.equal(approvedSecond.pending[0]?.createdAt, reusedT1.createdAt)
      assert.ok(commandCalls.at(-1)?.args.includes(secondDuplicateT1.spec))
    } finally {
      runtime.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

    // approve (new worktree -> headless worktree create via runCommand)
    const approveHandler = fake.handlers.get('console.approve')
    assert.ok(approveHandler)
    const approved = (await approveHandler({ taskId: '#T1' })) as ConsoleState
    assert.equal(approved.pending.length, 0)
    assert.ok(approved.workers.some((w) => w.taskId === '#T1' && w.status === 'working'))
    const approveCall = commandCalls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'create')
    assert.ok(approveCall)
    assert.equal(approveCall.args.includes('--activate'), false)
    assert.equal(approveCall.args.includes('--model'), true)
    assert.equal(approveCall.args.includes('--prompt'), true)
    assert.equal(approveCall.args.includes('worker-start'), false)

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

test('dispatches track3 tasks as Track 3 even via console.approve, forwards model/effort to existing CLI, and fails closed on unmatched or cross-project existing targets', async () => {
  // 1. Existing worktree matched strictly within same project & local host forwards model/effort via CLI
  const fakeMatched = fakeOrca({
    workspaces: [
      {
        id: 'ws-obs-existing',
        kind: 'worktree',
        name: 'obs-followup',
        project: 'ObsidianAutomation',
        projectId: 'proj-obs',
        path: '/Users/test/wt/obs-validation-followup',
        branch: 'refs/heads/feat/followup',
        hostId: 'local',
        status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
      }
    ]
  })
  const matchedCalls: Array<{ cmd: string; args: string[] }> = []
  const matchedRuntime = createRuntime(fakeMatched.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    readPendingQueue: async () => [
      {
        taskId: '#T10',
        domain: 'ObsidianAutomation',
        projectId: 'proj-obs',
        track: 'track2',
        worktreeMode: 'existing',
        worktreeName: 'obs-validation-followup',
        title: '기존 워크트리 검증',
        spec: '기존 워크트리 obs-validation-followup의 회귀 테스트를 실행하라.',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        billingType: 'subscription',
        estimatedCostUsd: 0,
        estimatedMinutes: 10,
        reason: 'Codex 주간 여유',
        oneLine: '추천 #T10',
        createdAt: 1_795_280_000_000
      }
    ],
    runCommand: async (cmd, args) => {
      matchedCalls.push({ cmd, args })
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await matchedRuntime.start()
  try {
    const refreshed = await matchedRuntime.refresh()
    const task = refreshed.pending.find((p) => p.taskId === '#T10')
    assert.ok(task)
    assert.equal(task.workspaceId, 'ws-obs-existing')
    assert.equal(task.domain, 'ObsidianAutomation')

    await fakeMatched.handlers.get('console.approve')!({ taskId: '#T10' })
    assert.equal(matchedCalls.length, 1)
    assert.deepEqual(matchedCalls[0]?.args.slice(0, 2), ['agent', 'launch'])
    assert.equal(matchedCalls[0]?.args.includes('id:ws-obs-existing'), true)
    assert.equal(matchedCalls[0]?.args.includes('gpt-6-astra'), true)
    assert.equal(matchedCalls[0]?.args.includes('high'), true)
    assert.equal(matchedCalls[0]?.args.includes('--focus'), false)
    assert.equal(matchedCalls[0]?.args.includes('worker-start'), false)
    assert.equal(
      matchedCalls[0]?.args.includes('기존 워크트리 obs-validation-followup의 회귀 테스트를 실행하라.'),
      true
    )
    assert.equal(
      fakeMatched.hostCalls.some((c) => c.method === 'agent.launch'),
      false
    )
  } finally {
    matchedRuntime.stop()
  }

  // 2. Track 3 task approved via console.approve obeys track3 and omits fixed/none effort
  const fakeTrack3 = fakeOrca()
  const track3Calls: Array<{ cmd: string; args: string[] }> = []
  const track3Runtime = createRuntime(fakeTrack3.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    readPendingQueue: async () => [
      {
        taskId: '#T11',
        domain: 'ObsidianAutomation',
        projectId: 'proj-obs',
        track: 'track3',
        worktreeMode: 'existing',
        worktreeName: 'feat/followup',
        title: 'UI 미세 조정 핸드오프',
        spec: '기존 워크트리에서 UI 패널 간격을 대화형으로 다듬는다.',
        agent: 'antigravity',
        model: 'gemini-pro-orchestrator-g1-pro',
        effort: 'fixed',
        billingType: 'subscription',
        estimatedCostUsd: 0,
        estimatedMinutes: 15,
        reason: 'Track 3 추천',
        oneLine: '추천 #T11',
        createdAt: 1_795_280_000_000
      }
    ],
    runCommand: async (cmd, args) => {
      track3Calls.push({ cmd, args })
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  fakeTrack3.workspaces.push({
    id: 'ws-obs-t3',
    kind: 'worktree',
    name: 'obs-t3',
    project: 'ObsidianAutomation',
    projectId: 'proj-obs',
    path: '/wt/obs-t3',
    branch: 'refs/heads/feat/followup',
    hostId: 'local',
    status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
  })
  await track3Runtime.start()
  try {
    await track3Runtime.refresh()
    const approvedT3 = (await fakeTrack3.handlers.get('console.approve')!({
      taskId: '#T11'
    })) as ConsoleState
    assert.equal(track3Calls.length, 1)
    assert.equal(track3Calls[0]?.args[0], 'agent')
    assert.equal(track3Calls[0]?.args[1], 'launch')
    assert.equal(track3Calls[0]?.args.includes('--surface'), true)
    assert.equal(track3Calls[0]?.args.includes('--focus'), true)
    assert.equal(track3Calls[0]?.args.includes('--effort'), false)
    assert.ok(approvedT3.workers.some((w) => w.taskId === '#T11' && w.track === 'Track 3' && w.status === 'handoff'))
  } finally {
    track3Runtime.stop()
  }

  // 3. Cross-project and nonexistent existing targets fail closed with ZERO CLI / agent.launch calls
  const fakeUnmatched = fakeOrca()
  const unmatchedCalls: Array<{ cmd: string; args: string[] }> = []
  const runtimeUnmatched = createRuntime(fakeUnmatched.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    readPendingQueue: async () => [
      {
        taskId: '#T12',
        domain: 'TennisClubManagement',
        projectId: 'proj-tcm',
        track: 'track2',
        worktreeMode: 'existing',
        worktreeName: 'desk-obs-dedup', // exists under proj-obs, NOT proj-tcm!
        title: '교차 프로젝트 오매칭 방지 검증',
        spec: '교차 프로젝트 워크트리는 절대 실행하면 안 된다.',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        billingType: 'subscription',
        estimatedCostUsd: 0,
        estimatedMinutes: 10,
        reason: '검증',
        oneLine: '추천 #T12',
        createdAt: 1_795_280_000_000
      }
    ],
    runCommand: async (cmd, args) => {
      unmatchedCalls.push({ cmd, args })
      return { exitCode: 0, stdout: '{}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await runtimeUnmatched.start()
  try {
    const state = await runtimeUnmatched.refresh()
    assert.equal(state.pending.find((p) => p.taskId === '#T12')?.workspaceId, null)

    let failedCode: string | undefined
    try {
      await fakeUnmatched.handlers.get('console.approve')!({ taskId: '#T12' })
    } catch (error) {
      failedCode = (error as { code?: string }).code
    }
    assert.equal(failedCode, 'invalid_params')
    assert.equal(unmatchedCalls.length, 0)
    assert.equal(
      fakeUnmatched.hostCalls.some((c) => c.method === 'agent.launch'),
      false
    )
    assert.equal(runtimeUnmatched.state().pending.length, 1)
  } finally {
    runtimeUnmatched.stop()
  }

  // 4. Explicit workspaceId pointing to a remote host or wrong project MUST ALSO fail closed
  const fakeBypass = fakeOrca({
    workspaces: [
      {
        id: 'ws-remote-other',
        kind: 'worktree',
        name: 'remote-wt',
        project: 'ObsidianAutomation',
        projectId: 'proj-obs',
        path: '/remote/wt',
        branch: 'feat/remote',
        hostId: 'ssh:remote-box',
        status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
      },
      {
        id: 'ws-obs-local',
        kind: 'worktree',
        name: 'obs-local',
        project: 'ObsidianAutomation',
        projectId: 'proj-obs',
        path: '/wt/obs-local',
        branch: 'feat/obs-local',
        hostId: 'local',
        status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
      }
    ]
  })
  const bypassCalls: Array<{ cmd: string; args: string[] }> = []
  const bypassRuntime = createRuntime(fakeBypass.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    readPendingQueue: async () => [
      {
        taskId: '#T13',
        domain: 'ObsidianAutomation',
        projectId: 'proj-obs',
        workspaceId: 'ws-remote-other',
        track: 'track2',
        worktreeMode: 'existing',
        worktreeName: 'remote-wt',
        title: '원격 workspaceId 차단 검증',
        spec: '원격 hostId workspaceId는 로컬 실행 시 거부되어야 한다.',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        billingType: 'subscription',
        estimatedCostUsd: 0,
        estimatedMinutes: 5,
        reason: '검증',
        oneLine: '추천 #T13',
        createdAt: 1_795_280_000_000
      },
      {
        taskId: '#T14',
        domain: 'TennisClubManagement',
        projectId: 'proj-tcm',
        workspaceId: 'ws-obs-local',
        track: 'track2',
        worktreeMode: 'existing',
        worktreeName: 'obs-local',
        title: '타 프로젝트 workspaceId 차단 검증',
        spec: '다른 프로젝트에 속한 workspaceId도 거부되어야 한다.',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        billingType: 'subscription',
        estimatedCostUsd: 0,
        estimatedMinutes: 5,
        reason: '검증',
        oneLine: '추천 #T14',
        createdAt: 1_795_280_000_100
      }
    ],
    runCommand: async (cmd, args) => {
      bypassCalls.push({ cmd, args })
      return { exitCode: 0, stdout: '{}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await bypassRuntime.start()
  try {
    const state = await bypassRuntime.refresh()
    assert.equal(state.pending.find((p) => p.taskId === '#T13')?.workspaceId, null)
    assert.equal(state.pending.find((p) => p.taskId === '#T14')?.workspaceId, null)

    for (const id of ['#T13', '#T14']) {
      let code: string | undefined
      try {
        await fakeBypass.handlers.get('console.approve')!({ taskId: id })
      } catch (error) {
        code = (error as { code?: string }).code
      }
      assert.equal(code, 'invalid_params')
    }
    assert.equal(bypassCalls.length, 0)
  } finally {
    bypassRuntime.stop()
  }
})

test('blocks concurrent duplicate approve calls and preserves task on CLI failure for clean retry', async () => {
  const fake = fakeOrca({
    storage: { 'intake-desk-console.pending': samplePendingTasks }
  })
  let failOnce = true
  let releaseCli!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseCli = resolve
  })
  let cliCount = 0

  const runtime = createRuntime(fake.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    runCommand: async () => {
      cliCount += 1
      await gate
      if (failOnce) {
        failOnce = false
        return { exitCode: 1, stdout: '', stderr: 'temporary dispatch failure' }
      }
      return { exitCode: 0, stdout: '{"workspaceId":"ws-retried"}', stderr: '' }
    },
    now: () => 1_795_280_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    const approveHandler = fake.handlers.get('console.approve')!
    const firstPromise = approveHandler({ taskId: '#T1' }) as Promise<ConsoleState>

    let dupCode: string | undefined
    try {
      await approveHandler({ taskId: '#T1' })
    } catch (error) {
      dupCode = (error as { code?: string }).code
    }
    assert.equal(dupCode, 'conflict')

    releaseCli()
    let failCode: string | undefined
    try {
      await firstPromise
    } catch (error) {
      failCode = (error as { code?: string }).code
    }
    assert.equal(failCode, 'action_failed')
    assert.equal(cliCount, 1)
    assert.equal(runtime.state().pending.length, 1)

    const retryState = (await approveHandler({ taskId: '#T1' })) as ConsoleState
    assert.equal(cliCount, 2)
    assert.equal(retryState.pending.length, 0)
    assert.ok(retryState.workers.some((w) => w.taskId === '#T1' && w.workspaceId === 'ws-retried'))
  } finally {
    runtime.stop()
  }
})

test('persists showQuotaSection via console.setShowQuota, validates input, and syncs settings.onDidChange', async () => {
  const persistedStorage: Record<string, unknown> = {}
  const fake1 = fakeOrca({ storage: persistedStorage })
  const runtime1 = createRuntime(fake1.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    now: () => 1_795_280_000_000
  })

  await runtime1.start()
  try {
    await runtime1.refresh()
    assert.equal(runtime1.state().showQuotaSection, true)

    const setShowQuota = fake1.handlers.get('console.setShowQuota')
    assert.ok(setShowQuota)

    let invalidCode: string | undefined
    try {
      await setShowQuota({ visible: 'nope' })
    } catch (error) {
      invalidCode = (error as { code?: string }).code
    }
    assert.equal(invalidCode, 'invalid_params')

    const hidden = (await setShowQuota({ visible: false })) as ConsoleState
    assert.equal(hidden.showQuotaSection, false)
    assert.equal(fake1.storage.get('intake-desk-console.showQuotaSection'), false)

    persistedStorage['intake-desk-console.showQuotaSection'] = fake1.storage.get(
      'intake-desk-console.showQuotaSection'
    )
  } finally {
    runtime1.stop()
  }

  // Restart with persisted storage: remains hidden even though settings.showQuotaSection defaults to true
  const fake2 = fakeOrca({ storage: persistedStorage })
  const runtime2 = createRuntime(fake2.orca, {
    collectAdvisor: async () => ({ ok: true, payload: liveAdvisorPayload }),
    now: () => 1_795_280_005_000
  })
  await runtime2.start()
  try {
    const refreshed = await runtime2.refresh()
    assert.equal(refreshed.showQuotaSection, false)

    // Updating plugin setting showQuotaSection overrides stored value immediately
    fake2.settings.showQuotaSection = true
    fake2.emitSettingsChange('showQuotaSection')
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(runtime2.state().showQuotaSection, true)

    fake2.settings.showQuotaSection = false
    fake2.emitSettingsChange('showQuotaSection')
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(runtime2.state().showQuotaSection, false)
  } finally {
    runtime2.stop()
  }
})
