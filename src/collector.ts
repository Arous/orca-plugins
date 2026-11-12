import type { CollectionError, CollectionResult } from './protocol'

// This function is serialized into the authenticated console page; keep all runtime dependencies inside it.
export async function collectUsage(expectedIdentity: string | null): Promise<CollectionResult> {
  type Session = { id?: unknown; getToken?: () => Promise<unknown> }
  type User = { id?: unknown }
  type Clerk = { loaded?: boolean; session?: Session | null; user?: User | null }
  type ClerkWindow = Window & { Clerk?: Clerk }
  const fail = (code: CollectionError): CollectionResult => ({ ok: false, code })
  if (location.origin !== 'https://opengateway.ai' || !['/dashboard', '/analysis'].includes(location.pathname)) {
    return fail('page-required')
  }

  if (expectedIdentity !== null && (typeof expectedIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(expectedIdentity))) {
    return fail('unexpected-response')
  }
  const clerkWindow = window as ClerkWindow
  // A restored tab may have started loading but not yet initialized Clerk.
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = clerkWindow.Clerk
    if (current && (current.loaded === true || (current.loaded !== false && current.session && current.user))) break
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 100)
    await promise
  }
  const clerk = clerkWindow.Clerk
  const session = clerk?.session
  const user = clerk?.user
  if (!clerk || clerk.loaded === false || !session || typeof session.id !== 'string' || !session.id || typeof session.getToken !== 'function' ||
      !user || typeof user.id !== 'string' || !user.id) {
    return fail('login-required')
  }
  const sessionId = session.id
  const userId = user.id
  let teamId: string | null
  try {
    teamId = localStorage.getItem('selectedTeamId')
  } catch {
    return fail('team-required')
  }
  if (!teamId || !teamId.trim()) return fail('team-required')
  const selectedTeam = teamId
  const unchanged = () => {
    try {
      return clerkWindow.Clerk === clerk && clerk.session === session && session.id === sessionId &&
        clerk.user === user && user.id === userId && localStorage.getItem('selectedTeamId') === selectedTeam
    } catch {
      return false
    }
  }
  const period = (timestamp: number) => {
    const date = new Date(timestamp + 9 * 60 * 60 * 1000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const day = date.getUTCDate()
    const start = Date.UTC(year, month, day) - 9 * 60 * 60 * 1000
    const end = Date.UTC(year, month, day + 1) - 9 * 60 * 60 * 1000
    const monthStart = Date.UTC(year, month, 1) - 9 * 60 * 60 * 1000
    const label = `${year}-${String(month + 1).padStart(2, '0')}`
    return { start, end, monthStart, day: `${label}-${String(day).padStart(2, '0')}`, month: label }
  }
  const initial = period(Date.now())
  const currentPeriod = () => period(Date.now()).day === initial.day
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const money = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const controller = new AbortController()
  const { promise: timeout, resolve } = Promise.withResolvers<CollectionResult>()
  const timer = setTimeout(() => {
    controller.abort()
    resolve(!unchanged() ? fail('account-changed') : !currentPeriod() ? fail('period-changed') : fail('network-error'))
  }, 20_000)
  const execute = async (): Promise<CollectionResult> => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([userId, selectedTeam])))
      if (!unchanged()) return fail('account-changed')
      if (!currentPeriod()) return fail('period-changed')
      if (controller.signal.aborted) return fail('network-error')
      const identityKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (expectedIdentity === null) return { ok: false, code: 'connection-required', identityKey }
      if (identityKey !== expectedIdentity) return fail('account-changed')
      const token = await session.getToken!()
      if (!unchanged()) return fail('account-changed')
      if (!currentPeriod()) return fail('period-changed')
      if (controller.signal.aborted) return fail('network-error')
      if (typeof token !== 'string' || !token) return fail('login-required')
      const base = 'https://apis.opengateway.ai/control-plane'
      const request = async (path: string, method: 'GET' | 'POST'): Promise<{ value?: unknown; error?: CollectionError }> => {
        if (controller.signal.aborted) return { error: 'network-error' }
        let response: Response
        try {
          response = await fetch(base + path, {
            method,
            headers: method === 'POST'
              ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
              : { Authorization: `Bearer ${token}` },
            credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          })
        } catch {
          return { error: !unchanged() ? 'account-changed' : !currentPeriod() ? 'period-changed' : 'network-error' }
        }
        if (!unchanged()) return { error: 'account-changed' }
        if (!currentPeriod()) return { error: 'period-changed' }
        if (response.status === 401 || response.status === 403) return { error: 'login-required' }
        if (response.status === 429) return { error: 'rate-limited' }
        if (!response.ok) return { error: 'network-error' }
        try {
          const value: unknown = await response.json()
          if (!unchanged()) return { error: 'account-changed' }
          if (!currentPeriod()) return { error: 'period-changed' }
          return { value }
        } catch {
          return { error: !unchanged() ? 'account-changed' : !currentPeriod() ? 'period-changed' : 'unexpected-response' }
        }
      }
      const user = await request('/api/v1/users', 'POST')
      if (user.error) return fail(user.error)
      if (!record(user.value) || !Array.isArray(user.value.teams)) return fail('unexpected-response')
      const team = user.value.teams.find((item: unknown) => record(item) && item.id === selectedTeam)
      if (!record(team)) return fail('unexpected-response')
      const balance = money(team.balance)
      if (balance === null) return fail('unexpected-response')
      const spend = async (start: number): Promise<{ value?: number; error?: CollectionError }> => {
        const startIso = new Date(start).toISOString()
        const endIso = new Date(initial.end).toISOString()
        const query = `?startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}&bucket=DAY`
        const response = await request(`/api/v1/teams/${encodeURIComponent(selectedTeam)}/views/spend-analysis${query}`, 'GET')
        if (response.error) return { error: response.error }
        const data = response.value
        if (!record(data) || typeof data.available !== 'boolean') return { error: 'unexpected-response' }
        if (!data.available) return { error: 'unavailable' }
        if (!record(data.window) || typeof data.window.start !== 'string' || typeof data.window.end !== 'string' ||
            Date.parse(data.window.start) !== start || Date.parse(data.window.end) !== initial.end ||
            !record(data.totals) || !record(data.totals.current) ||
            typeof data.totals.current.spend !== 'number' || !Number.isFinite(data.totals.current.spend)) {
          return { error: 'unexpected-response' }
        }
        return { value: data.totals.current.spend }
      }
      const today = await spend(initial.start)
      if (today.error) return fail(today.error)
      const month = await spend(initial.monthStart)
      if (month.error) return fail(month.error)
      if (!unchanged()) return fail('account-changed')
      const updatedAt = Date.now()
      if (period(updatedAt).day !== initial.day) return fail('period-changed')
      return { ok: true, snapshot: { balanceUsd: balance, todayUsd: today.value!, monthUsd: month.value!, updatedAt, periodDay: initial.day, periodMonth: initial.month } }
    } catch {
      if (!unchanged()) return fail('account-changed')
      if (!currentPeriod()) return fail('period-changed')
      return fail('network-error')
    }
  }
  try {
    return await Promise.race([execute(), timeout])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
