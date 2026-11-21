import type { OrcaWorkerApi } from 'orca/worker'
import { buildSample, type RemoteMetrics } from './collector'
import { CollectorError } from './errors'
import { statusBarText, statusBarTooltip, statusSummary, statusTone } from './format'
import {
  DEFAULT_HOST,
  DEFAULT_POLL_SECONDS,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  type HostState,
  type NetCounters
} from './protocol'
import { collectRemote, isValidHost } from './ssh'

export type Collector = (host: string, signal: AbortSignal) => Promise<RemoteMetrics>

export type RuntimeDeps = {
  collect?: Collector
  now?: () => number
}

export type RuntimeSettings = {
  host: string
  pollSeconds: number
}

export type HostRuntime = {
  start(): Promise<void>
  stop(): void
  refresh(): Promise<HostState>
  reloadSettings(): Promise<void>
  state(): HostState
}

type Disposable = { dispose(): void }

function initialState(host: string): HostState {
  return {
    status: 'loading',
    host,
    sample: null,
    error: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    refreshing: false
  }
}

async function readSettings(orca: OrcaWorkerApi): Promise<RuntimeSettings> {
  const [hostValue, pollValue] = await Promise.all([
    orca.settings.get('host'),
    orca.settings.get('pollSeconds')
  ])
  const host = typeof hostValue === 'string' && hostValue.trim() ? hostValue.trim() : DEFAULT_HOST
  const candidate = typeof pollValue === 'number' && Number.isFinite(pollValue)
    ? Math.round(pollValue)
    : DEFAULT_POLL_SECONDS
  return {
    host,
    pollSeconds: Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, candidate))
  }
}

function errorText(error: unknown): string {
  if (error instanceof CollectorError) {
    switch (error.code) {
      case 'host-invalid': return 'SSH 호스트 별칭이 올바르지 않습니다.'
      case 'timeout': return 'SSH 응답 시간이 초과되었습니다.'
      case 'cancelled': return '자원 조회가 취소되었습니다.'
      case 'parse-failed': return 'macOS 자원 출력을 해석하지 못했습니다.'
      default: return 'SSH 연결에 실패했습니다. 호스트와 키를 확인하세요.'
    }
  }
  return 'MacBook 자원을 조회하지 못했습니다.'
}

/**
 * Worker state machine, separated from the Orca runtime entry point so tests can inject a
 * collector and clock. Every refresh either replaces the sample or keeps the last one as stale.
 */
export function createRuntime(orca: OrcaWorkerApi, deps: RuntimeDeps = {}): HostRuntime {
  const collect = deps.collect ?? ((host: string, signal: AbortSignal) => collectRemote(host, signal))
  const now = deps.now ?? Date.now
  const disposables: Disposable[] = []
  let settings: RuntimeSettings = { host: DEFAULT_HOST, pollSeconds: DEFAULT_POLL_SECONDS }
  let state = initialState(settings.host)
  let previous: NetCounters | null = null
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<HostState> | null = null
  let controller: AbortController | null = null
  let runId = 0
  let stopped = false
  let failures = 0

  function publish(): void {
    orca.panels.post('stats.changed', state)
    void orca.host.call('statusBar.update', {
      id: 'host-stats',
      text: statusBarText(state),
      tone: statusTone(state.status),
      tooltip: statusBarTooltip(state),
      visible: true
    }).catch(() => {})
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

  function refresh(): Promise<HostState> {
    if (stopped) return Promise.resolve(state)
    if (inFlight) return inFlight

    clearTimeout(timer)
    const id = ++runId
    const host = settings.host
    const attemptAt = now()
    state = { ...state, host, refreshing: true, lastAttemptAt: attemptAt }
    publish()
    const current = new AbortController()
    controller = current

    const run = (async (): Promise<HostState> => {
      await Promise.resolve()
      try {
        if (!isValidHost(host)) throw new CollectorError('host-invalid', 'invalid host')
        const remote = await collect(host, current.signal)
        if (stopped || settings.host !== host) return state
        const at = now()
        const sample = buildSample(remote, previous, host, at)
        previous = {
          at,
          bootTimeSeconds: sample.bootTimeSeconds,
          interface: sample.network.interface,
          rxBytes: sample.network.rxBytes,
          txBytes: sample.network.txBytes
        }
        state = {
          status: 'ready',
          host,
          sample,
          error: null,
          lastAttemptAt: attemptAt,
          lastSuccessAt: at,
          refreshing: false
        }
        failures = 0
      } catch (error) {
        if (stopped || settings.host !== host) return state
        failures += 1
        state = {
          ...state,
          status: state.lastSuccessAt === null ? 'error' : 'stale',
          error: errorText(error),
          refreshing: false
        }
      } finally {
        if (runId === id) inFlight = null
        if (controller === current) controller = null
        if (!stopped && settings.host === host) {
          publish()
          schedule()
        }
      }
      return state
    })()

    inFlight = run
    return run
  }

  async function reloadSettings(): Promise<void> {
    if (stopped) return
    const next = await readSettings(orca)
    if (stopped) return
    const hostChanged = next.host !== settings.host
    const intervalChanged = next.pollSeconds !== settings.pollSeconds
    settings = next
    if (hostChanged) {
      const pending = inFlight
      controller?.abort()
      previous = null
      failures = 0
      state = initialState(settings.host)
      clearTimeout(timer)
      publish()
      if (pending) await pending.catch(() => undefined)
      if (!stopped) void refresh()
      return
    }
    if (intervalChanged) {
      clearTimeout(timer)
      schedule()
    }
    state = { ...state, host: settings.host }
  }

  async function start(): Promise<void> {
    stopped = false
    try {
      settings = await readSettings(orca)
    } catch {
      orca.log('MacBook Host Stats: settings read failed; using defaults')
    }
    state = { ...state, host: settings.host }
    disposables.push(orca.panels.handle('stats.get', () => state))
    disposables.push(orca.panels.handle('stats.refresh', () => refresh()))
    disposables.push(orca.commands.register('refresh', async () => {
      await refresh()
      return statusSummary(state)
    }))
    disposables.push(orca.settings.onDidChange(() => {
      void reloadSettings().catch(() => orca.log('MacBook Host Stats: settings reload failed'))
    }))
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

let runtime: HostRuntime | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  runtime = createRuntime(orca)
  await runtime.start()
}

export function deactivate(): void {
  runtime?.stop()
  runtime = null
}
