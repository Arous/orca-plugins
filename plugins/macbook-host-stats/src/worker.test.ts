import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import { CollectorError } from './errors'
import { remoteMetrics } from './fixtures'
import type { HostState } from './protocol'
import { createRuntime } from './worker'

type StatusCall = { id: string; text?: string; tone?: string; tooltip?: string; visible?: boolean }

function fakeOrca(initial: Record<string, unknown> = {}, failSettings = false) {
  const settings: Record<string, unknown> = { host: 'macbook2015', pollSeconds: 30, ...initial }
  let settingsUnavailable = failSettings
  const handlers = new Map<string, (input?: unknown) => unknown>()
  const posts: HostState[] = []
  const status: StatusCall[] = []
  const logs: string[] = []
  const changes: Array<(change: { key: string }) => void> = []
  const disposable = { dispose() {} }

  const orca = {
    api: { major: 1, minor: 10 },
    commands: {
      register: (id: string, handler: (args: unknown, context: unknown) => unknown) => {
        handlers.set(`command:${id}`, (args) => handler(args, { signal: new AbortController().signal }))
        return disposable
      }
    },
    events: { on: () => disposable },
    hooks: { on: () => disposable },
    host: {
      call: async (method: string, params: unknown) => {
        if (method === 'statusBar.update') status.push(params as StatusCall)
        return { ok: true }
      }
    },
    panels: {
      handle: (name: string, handler: (input?: unknown) => unknown) => {
        handlers.set(name, handler)
        return disposable
      },
      post: (event: string, payload: HostState) => {
        if (event === 'stats.changed') posts.push(payload)
      }
    },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
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
        changes.push(listener)
        return disposable
      }
    },
    secrets: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    },
    grantedCapabilities: ['settings:own'],
    log: (message: string) => logs.push(message)
  } as unknown as OrcaWorkerApi

  return {
    orca, settings, handlers, posts, status, logs, changes,
    setSettingsFailure: (value: boolean) => { settingsUnavailable = value }
  }
}

test('publishes a ready sample and updates the status bar', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collect: async () => remoteMetrics,
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.sample?.disk.usedPercent, 42)
    assert.equal(fake.status.at(-1)?.text, 'MBP 12% · 6% · 42%')
    assert.equal(fake.status.at(-1)?.tone, 'success')
    assert.ok(fake.posts.some((post) => post.status === 'ready'))
    assert.deepEqual(fake.handlers.get('stats.get')?.(), state)
  } finally {
    runtime.stop()
  }
})

test('keeps the last sample when a later SSH attempt fails', async () => {
  const fake = fakeOrca()
  let fail = false
  let clock = 1_000_000
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      if (fail) throw new CollectorError('ssh-failed', 'failed')
      return remoteMetrics
    },
    now: () => (clock += 1000)
  })
  await runtime.start()
  try {
    await runtime.refresh()
    fail = true
    const state = await runtime.refresh()
    assert.equal(state.status, 'stale')
    assert.ok(state.sample)
    assert.equal(state.error, 'SSH 연결에 실패했습니다. 호스트와 키를 확인하세요.')
    assert.equal(fake.status.at(-1)?.text, 'MBP 연결 지연')
    assert.equal(fake.status.at(-1)?.tone, 'warning')
  } finally {
    runtime.stop()
  }
})

test('reports an error when no sample has ever succeeded', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      throw new CollectorError('timeout', 'timeout')
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'SSH 응답 시간이 초과되었습니다.')
    assert.equal(fake.status.at(-1)?.text, 'MBP 연결 안 됨')
    assert.equal(fake.status.at(-1)?.tone, 'danger')
  } finally {
    runtime.stop()
  }
})

test('does not fall back to the default host when settings fail', async () => {
  const fake = fakeOrca({}, true)
  let called = false
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      called = true
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    const state = runtime.state()
    assert.equal(state.status, 'error')
    assert.equal(state.error, '플러그인 설정을 읽지 못했습니다.')
    assert.equal(called, false)
    assert.equal(fake.status.at(-1)?.tone, 'danger')
  } finally {
    runtime.stop()
  }
})

test('retries settings before collecting after a transient failure', async () => {
  const fake = fakeOrca({}, true)
  let called = 0
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      called += 1
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    assert.equal(runtime.state().status, 'error')
    fake.setSettingsFailure(false)
    const state = await runtime.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(called, 1)
  } finally {
    runtime.stop()
  }
})

test('rejects an unsafe host alias without starting SSH', async () => {
  const fake = fakeOrca({ host: '-oProxyCommand=bad' })
  let called = false
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      called = true
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    const state = await runtime.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'SSH 호스트 별칭이 올바르지 않습니다.')
    assert.equal(called, false)
  } finally {
    runtime.stop()
  }
})

test('single-flights settings recovery and collection', async () => {
  const fake = fakeOrca({}, true)
  let calls = 0
  const runtime = createRuntime(fake.orca, {
    collect: async () => {
      calls += 1
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    fake.setSettingsFailure(false)
    const [first, second] = await Promise.all([runtime.refresh(), runtime.refresh()])
    assert.equal(first, second)
    assert.equal(calls, 1)
  } finally {
    runtime.stop()
  }
})

test('recovers the configured host after a failed settings reload', async () => {
  const fake = fakeOrca()
  const hosts: string[] = []
  const runtime = createRuntime(fake.orca, {
    collect: async (host) => {
      hosts.push(host)
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    fake.settings.host = 'other-mac'
    fake.setSettingsFailure(true)
    await runtime.reloadSettings()
    assert.equal(runtime.state().status, 'stale')

    fake.setSettingsFailure(false)
    const state = await runtime.refresh()
    assert.equal(state.host, 'other-mac')
    assert.equal(hosts.at(-1), 'other-mac')
  } finally {
    runtime.stop()
  }
})

test('drops the old sample when a host change fails SSH', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collect: async (host) => {
      if (host === 'other-mac') throw new CollectorError('ssh-failed', 'failed')
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    fake.settings.host = 'other-mac'
    await runtime.reloadSettings()
    await runtime.refresh()
    const state = runtime.state()
    assert.equal(state.host, 'other-mac')
    assert.equal(state.sample, null)
    assert.equal(state.status, 'error')
  } finally {
    runtime.stop()
  }
})

test('keeps the last sample across repeated settings failures', async () => {
  const fake = fakeOrca()
  const runtime = createRuntime(fake.orca, {
    collect: async () => remoteMetrics,
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    fake.setSettingsFailure(true)
    await runtime.reloadSettings()
    assert.ok(runtime.state().sample)
    await runtime.refresh()
    const state = runtime.state()
    assert.ok(state.sample)
    assert.equal(state.status, 'stale')
  } finally {
    runtime.stop()
  }
})

test('switches hosts when the setting changes', async () => {
  const fake = fakeOrca()
  const hosts: string[] = []
  const runtime = createRuntime(fake.orca, {
    collect: async (host) => {
      hosts.push(host)
      return remoteMetrics
    },
    now: () => 1_000_000
  })
  await runtime.start()
  try {
    await runtime.refresh()
    hosts.length = 0
    fake.settings.host = 'other-mac'
    await runtime.reloadSettings()
    const state = await runtime.refresh()
    assert.equal(state.host, 'other-mac')
    assert.ok(hosts.length > 0)
    assert.ok(hosts.every((host) => host === 'other-mac'))
  } finally {
    runtime.stop()
  }
})
