import type { OrcaWorkerApi } from 'orca/worker'
import { browserBridge } from './browser'
import { footerText, footerTooltip } from './presentation'
import type { BrowserBridge, BrowserTarget, CollectionError, CollectionResult, SavedConnection, UsageState } from './protocol'

const CONNECTION = 'connection'
const LEGACY_TAB = 'selected-tab-id'
const REFRESH_MS = 5 * 60_000
const DAY_MS = 86_400_000
const KST_OFFSET = 9 * 3_600_000
const IDENTITY = /^[a-f0-9]{64}$/
const errors: Record<CollectionError, string> = {
  'login-required': 'OpenGateway 로그인/열기에서 로그인하세요. 로그인 후 연결 상태를 다시 확인합니다.',
  'page-required': 'OpenGateway 로그인/열기에서 연결 화면을 확인하세요.',
  'team-required': 'OpenGateway 화면에서 조회할 팀을 선택하세요.',
  'account-changed': 'OpenGateway의 계정 또는 팀이 변경되었습니다. 연결 대상을 다시 확인하세요.',
  'period-changed': '한국 시간 날짜가 변경되었습니다. 새로고침하세요.',
  'rate-limited': 'OpenGateway 조회 한도에 도달했습니다. 잠시 후 새로고침하세요.',
  'unavailable': 'OpenGateway 사용액 집계가 아직 준비되지 않았습니다.',
  'unexpected-response': 'OpenGateway 응답 형식이 달라 조회를 중단했습니다.',
  'network-error': 'OpenGateway에 연결하지 못했습니다. 연결 상태를 확인하세요.'
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !value.startsWith('-') && !/[\r\n\0]/.test(value)
}

function savedConnection(value: unknown): SavedConnection | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) || value === undefined) throw new Error('Invalid connection')
  const saved = value as Record<string, unknown>
  if (!identifier(saved.tabId) || !identifier(saved.profileId) || !identifier(saved.worktreeId) ||
    !(saved.identityKey === null || (typeof saved.identityKey === 'string' && IDENTITY.test(saved.identityKey)))) {
    throw new Error('Invalid connection')
  }
  return { tabId: saved.tabId, profileId: saved.profileId, worktreeId: saved.worktreeId, identityKey: saved.identityKey }
}

export function createWorker(bridge: BrowserBridge) {
  let stop: (() => void) | undefined

  function activate(orca: OrcaWorkerApi): void {
    const controller = new AbortController()
    let stopped = false
    let loaded = false
    let connection: SavedConnection | null = null
    let dirty = false
    let legacyTabId: string | null = null
    let operation: Promise<void> | null = null
    let paint = Promise.resolve()
    let timer: NodeJS.Timeout | undefined
    let state: UsageState = {
      status: 'loading', message: 'OpenGateway 연결을 확인하고 있습니다.',
      snapshot: null, checkedAt: null, refreshing: false,
      canConnect: false, confirmationKey: null, connected: false
    }

    async function render(value: UsageState): Promise<void> {
      if (stopped) return
      const snapshot = value.status === 'ready' ? value.snapshot : null
      const label = value.refreshing ? '조회 중' : {
        loading: '연결 중', ready: '준비됨', 'login-required': '로그인 필요',
        'connection-required': '연결 확인', unavailable: '집계 대기', error: '조회 실패'
      }[value.status]
      await orca.host.call('statusBar.update', {
        id: 'usage', text: snapshot ? footerText(snapshot) : `OG ${label}`,
        tone: snapshot || value.refreshing ? 'neutral' : 'warning',
        tooltip: snapshot ? footerTooltip(snapshot) : `${value.message}\n오른쪽 OpenGateway Usage 패널에서 확인할 수 있습니다.`,
        visible: true
      })
    }

    function publish(): void {
      if (stopped) return
      state = { ...state, connected: connection?.identityKey != null }
      const value = state
      orca.panels.post('usage.changed', value)
      paint = paint.then(() => render(value)).catch(() => {
        if (!stopped) orca.log('OpenGateway status bar update failed; no account data logged.')
      })
    }

    function schedule(): void {
      if (stopped) return
      clearTimeout(timer)
      const now = Date.now()
      const nextMidnight = (Math.floor((now + KST_OFFSET) / DAY_MS) + 1) * DAY_MS - KST_OFFSET
      timer = setTimeout(() => start(refresh), Math.max(1000, Math.min(REFRESH_MS, nextMidnight - now)))
      timer.unref()
    }

    function start(work: () => Promise<void>): UsageState {
      if (stopped || operation) return state
      clearTimeout(timer)
      state = {
        ...state, status: 'loading', snapshot: null, refreshing: true,
        canConnect: false, confirmationKey: null, message: 'OpenGateway 연결을 복구하고 조회하고 있습니다.'
      }
      publish()
      operation = work().catch(() => {
        if (!stopped) state = {
          ...state, status: 'error', snapshot: null, canConnect: false, confirmationKey: null,
          message: '저장된 연결 또는 Orca 브라우저를 확인할 수 없습니다. 연결한 프로필·워크스페이스와 Orca CLI를 확인하세요.'
        }
      }).finally(() => {
        operation = null
        if (stopped) return
        state = { ...state, refreshing: false, checkedAt: Date.now() }
        publish()
        schedule()
      })
      return state
    }

    async function save(): Promise<void> {
      if (stopped || !connection) return
      if (dirty) {
        await orca.storage.set(CONNECTION, { ...connection })
        dirty = false
      }
      if (!stopped && legacyTabId !== null) {
        await orca.storage.delete(LEGACY_TAB)
        legacyTabId = null
      }
    }

    async function target(): Promise<BrowserTarget | null> {
      if (!loaded) throw new Error('Connection not loaded')
      const previous = connection
      const next = await bridge.ensureTab(previous, legacyTabId, controller.signal)
      if (stopped) return null
      if (!identifier(next.tabId) || !identifier(next.profileId) || !identifier(next.worktreeId) ||
        (previous && (previous.profileId !== next.profileId || previous.worktreeId !== next.worktreeId))) {
        throw new Error('Connection scope changed')
      }
      if (!connection || connection.tabId !== next.tabId) {
        connection = { ...next, identityKey: previous?.identityKey ?? null }
        dirty = true
      }
      await save()
      return stopped ? null : next
    }

    function apply(result: CollectionResult, changed = false): void {
      if (stopped) return
      if (result.ok) {
        state = {
          ...state, status: 'ready', snapshot: result.snapshot, canConnect: false, confirmationKey: null,
          message: '조회 완료 · USD · Asia/Seoul 기준'
        }
      } else if (result.code === 'connection-required') {
        if (!IDENTITY.test(result.identityKey)) throw new Error('Invalid identity confirmation')
        state = {
          ...state, status: 'connection-required', snapshot: null,
          canConnect: true, confirmationKey: result.identityKey,
          message: changed
            ? '계정 또는 팀이 변경되었습니다. OpenGateway 화면을 확인한 뒤 이 계정·팀으로 연결하세요.'
            : 'OpenGateway 화면의 계정·팀을 확인한 뒤 한 번 연결하세요. 이후에는 전용 탭을 자동으로 복구합니다.'
        }
      } else {
        state = {
          ...state, snapshot: null, canConnect: false, confirmationKey: null,
          status: result.code === 'team-required' ? 'connection-required'
            : ['login-required', 'page-required'].includes(result.code) ? 'login-required'
              : result.code === 'unavailable' ? 'unavailable' : 'error',
          message: errors[result.code]
        }
      }
    }

    async function inspect(current: BrowserTarget): Promise<void> {
      const identityKey = connection?.identityKey ?? null
      const result = await bridge.collect(current, identityKey, controller.signal)
      if (stopped) return
      if (identityKey === null && result.ok) throw new Error('Unconfirmed accounting result')
      if (!result.ok && result.code === 'account-changed' && identityKey) {
        const probe = await bridge.collect(current, null, controller.signal)
        if (stopped) return
        if (probe.ok) throw new Error('Identity probe unexpectedly returned accounting data')
        apply(probe, true)
      } else {
        apply(result)
      }
    }

    async function refresh(): Promise<void> {
      const current = await target()
      if (current) await inspect(current)
    }

    async function open(): Promise<void> {
      const current = await target()
      if (!current) return
      await bridge.revealTab(current, controller.signal)
      if (!stopped) await inspect(current)
    }

    async function connect(identityKey: string): Promise<void> {
      const current = await target()
      if (!current) return
      const probe = await bridge.collect(current, null, controller.signal)
      if (stopped) return
      if (probe.ok) throw new Error('Identity probe unexpectedly returned accounting data')
      if (probe.code !== 'connection-required' || probe.identityKey !== identityKey) {
        apply(probe, true)
        return
      }
      connection = { ...current, identityKey }
      dirty = true
      await save()
      if (!stopped) await inspect(current)
    }

    const subscriptions = [
      orca.panels.handle('usage.get', () => state),
      orca.panels.handle('usage.refresh', () => start(refresh)),
      orca.panels.handle('usage.open', () => start(open)),
      orca.panels.handle('usage.connect', ({ identityKey }) => {
        if (stopped || operation || !state.canConnect || state.confirmationKey !== identityKey) {
          throw new Error('Connection confirmation expired')
        }
        return start(() => connect(identityKey))
      }),
      orca.commands.register('refresh', () => {
        start(refresh)
        return 'OpenGateway 조회를 요청했습니다.'
      })
    ]
    stop = () => {
      stopped = true
      controller.abort()
      clearTimeout(timer)
      for (const subscription of subscriptions) subscription.dispose()
    }
    start(async () => {
      connection = savedConnection(await orca.storage.get(CONNECTION))
      const legacy = await orca.storage.get(LEGACY_TAB)
      if (legacy !== null && !identifier(legacy)) throw new Error('Invalid legacy connection')
      legacyTabId = legacy
      if (stopped) return
      loaded = true
      await refresh()
    })
  }

  return { default: activate, deactivate: () => stop?.() }
}

const worker = createWorker(browserBridge)
export default worker.default
export const deactivate = worker.deactivate
