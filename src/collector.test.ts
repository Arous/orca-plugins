import { assert, test } from 'orca/testing'
import { runInNewContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import { collectUsage } from './collector'


type Reply = { status?: number; body?: unknown; invalidJson?: boolean }
type Options = {
  now?: string
  origin?: string
  path?: string
  team?: string | null
  loggedOut?: boolean
  userId?: string
  sessionId?: string
  expectedIdentity?: string | null
  readyAfter?: number
  onDigest?: (state: Harness) => void
  onToken?: (state: Harness) => void
  replies?: Reply[]
  onFetch?: (state: Harness, index: number) => void
}
type Harness = {
  now: number
  team: string | null
  user: { id: string } | null
  tokens: number
  session: { id: string; getToken: () => Promise<string> } | null
  calls: { url: string; init: RequestInit }[]
}

async function run(options: Options = {}) {
  const state: Harness = {
    now: Date.parse(options.now ?? '2024-03-15T12:00:00.000Z'),
    team: options.team === undefined ? 'team / synthetic' : options.team,
    user: options.loggedOut ? null : { id: options.userId ?? 'user-synthetic' },
    tokens: 0,
    session: options.loggedOut ? null : { id: options.sessionId ?? 'session-synthetic', getToken: async () => {
      state.tokens++
      options.onToken?.(state)
      return 'secret-token-synthetic'
    } },
    calls: [],
  }
  const replies = options.replies ?? [
    { body: { teams: [{ id: 'team / synthetic', balance: '12.50', identity: 'private-synthetic' }] } },
    { body: { available: true, window: { start: '2024-03-14T15:00:00.000Z', end: '2024-03-15T15:00:00.000Z' }, totals: { current: { spend: 0 } } } },
    { body: { available: true, window: { start: '2024-02-29T15:00:00.000Z', end: '2024-03-15T15:00:00.000Z' }, totals: { current: { spend: 7.25 } } } },
  ]
  class Clock extends Date {
    constructor(value?: string | number) { super(value === undefined ? state.now : value) }
    static now() { return state.now }
  }
  let readinessChecks = 0
  const context = {
    location: { origin: options.origin ?? 'https://opengateway.ai', pathname: options.path ?? '/analysis' },
    window: { Clerk: { get loaded() { return readinessChecks++ >= (options.readyAfter ?? 0) }, get session() { return state.session }, get user() { return state.user } } },
    localStorage: { getItem(key: string) { assert.equal(key, 'selectedTeamId'); return state.team } },
    Date: Clock, AbortController, setTimeout, clearTimeout,
    TextEncoder,
    crypto: { subtle: { digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      options.onDigest?.(state)
      return webcrypto.subtle.digest(algorithm, data as Parameters<typeof webcrypto.subtle.digest>[1])
    } } },
    fetch: async (url: string, init: RequestInit) => {
      const index = state.calls.length
      state.calls.push({ url, init })
      options.onFetch?.(state, index)
      const reply = replies[index]
      if (!reply) throw new Error('synthetic missing reply')
      const status = reply.status ?? 200
      return { status, ok: status >= 200 && status < 300, json: async () => {
        if (reply.invalidJson) throw new Error('private-synthetic')
        return reply.body
      } }
    },
  }
  const expected = options.expectedIdentity === undefined
    ? createHash('sha256').update(JSON.stringify(['user-synthetic', 'team / synthetic'])).digest('hex')
    : options.expectedIdentity
  const result: unknown = await runInNewContext(`(${collectUsage.toString()})(${JSON.stringify(expected)})`, context)
  const plain: unknown = JSON.parse(JSON.stringify(result))
  return { result: plain, state }
}

const user = (balance: unknown = 5): Reply => ({ body: { teams: [{ id: 'team / synthetic', balance }] } })
const rollup = (start: string, end: string, spend: unknown): Reply => ({
  body: { available: true, window: { start, end }, totals: { current: { spend } } },
})

test('signed-in landing dashboard yields metrics through restricted in-page requests', async () => {
  const { result, state } = await run({ path: '/dashboard' })
  assert.deepEqual(result, { ok: true, snapshot: { balanceUsd: 12.5, todayUsd: 0, monthUsd: 7.25, updatedAt: Date.parse('2024-03-15T12:00:00Z'), periodDay: '2024-03-15', periodMonth: '2024-03' } })
  assert.equal(state.calls.length, 3)
  assert.equal(state.calls[0].url, 'https://apis.opengateway.ai/control-plane/api/v1/users')
  assert.equal(state.calls[0].init.method, 'POST')
  assert.equal(state.calls[0].init.body, undefined)
  assert.equal(new Headers(state.calls[0].init.headers).get('Content-Type'), 'application/json')
  for (const call of state.calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.credentials, 'omit')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer secret-token-synthetic')
  }
  const day = new URL(state.calls[1].url)
  assert.equal(day.pathname, '/control-plane/api/v1/teams/team%20%2F%20synthetic/views/spend-analysis')
  assert.equal(day.searchParams.get('startTime'), '2024-03-14T15:00:00.000Z')
  assert.equal(day.searchParams.get('endTime'), '2024-03-15T15:00:00.000Z')
  assert.equal(day.searchParams.get('bucket'), 'DAY')
  assert.equal(new URL(state.calls[2].url).searchParams.get('startTime'), '2024-02-29T15:00:00.000Z')
  assert.equal(JSON.stringify(result).includes('synthetic'), false)
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
})

test('KST leap day, month and year boundaries use calendar midnights', async () => {
  for (const example of [
    { now: '2024-02-29T14:59:59Z', day: '2024-02-28T15:00:00Z', end: '2024-02-29T15:00:00Z', month: '2024-01-31T15:00:00Z', label: '2024-02-29', monthLabel: '2024-02' },
    { now: '2024-02-29T15:00:00Z', day: '2024-02-29T15:00:00Z', end: '2024-03-01T15:00:00Z', month: '2024-02-29T15:00:00Z', label: '2024-03-01', monthLabel: '2024-03' },
    { now: '2024-12-31T15:00:00Z', day: '2024-12-31T15:00:00Z', end: '2025-01-01T15:00:00Z', month: '2024-12-31T15:00:00Z', label: '2025-01-01', monthLabel: '2025-01' },
  ]) {
    const { result, state } = await run({ now: example.now, replies: [user(), rollup(example.day, example.end, 1), rollup(example.month, example.end, 2)] })
    assert.deepEqual(result, { ok: true, snapshot: { balanceUsd: 5, todayUsd: 1, monthUsd: 2, updatedAt: Date.parse(example.now), periodDay: example.label, periodMonth: example.monthLabel } })
    assert.equal(Date.parse(new URL(state.calls[1].url).searchParams.get('startTime')!), Date.parse(example.day))
    assert.equal(Date.parse(new URL(state.calls[1].url).searchParams.get('endTime')!), Date.parse(example.end))
    assert.equal(Date.parse(new URL(state.calls[2].url).searchParams.get('startTime')!), Date.parse(example.month))
  }
})

test('unavailable rollups are not interpreted as zero', async () => {
  const { result } = await run({ replies: [user(), { body: { available: false, code: 'ROLLUP_NOT_READY' } }] })
  assert.deepEqual(result, { ok: false, code: 'unavailable' })
})

test('rejects malformed balances, spend and mismatched windows', async () => {
  for (const value of ['', ' 2', '01', '1e2', 'Infinity', NaN, Infinity, null, {}, '9'.repeat(400)]) {
    const { result } = await run({ replies: [user(value)] })
    assert.deepEqual(result, { ok: false, code: 'unexpected-response' })
  }
  for (const reply of [
    rollup('2024-03-13T15:00:00Z', '2024-03-15T15:00:00Z', 1),
    rollup('2024-03-14T15:00:00Z', '2024-03-16T15:00:00Z', 1),
    rollup('2024-03-14T15:00:00Z', '2024-03-15T15:00:00Z', '1'),
    rollup('2024-03-14T15:00:00Z', '2024-03-15T15:00:00Z', Infinity),
    { body: { available: true, totals: { current: { spend: 1 } } } },
  ]) {
    const { result } = await run({ replies: [user(), reply] })
    assert.deepEqual(result, { ok: false, code: 'unexpected-response' })
  }
})

test('detects team, session object and session id switches during fetch', async () => {
  for (const change of [
    (s: Harness) => { s.team = 'other-synthetic' },
    (s: Harness) => { s.session = null },
    (s: Harness) => { s.session = { id: 'session-synthetic', getToken: async () => 'other' } },
    (s: Harness) => { s.user = { id: 'other-synthetic' } },
    (s: Harness) => { if (s.user) s.user.id = 'other-synthetic' },
    (s: Harness) => { if (s.session) s.session.id = 'other-synthetic' },
  ]) {
    const { result, state } = await run({ onFetch: (s, index) => { if (index === 1) change(s) } })
    assert.deepEqual(result, { ok: false, code: 'account-changed' })
    assert.equal(state.calls.length, 2)
  }
})

test('rejects a KST midnight crossed during collection', async () => {
  const { result } = await run({ now: '2024-02-29T14:59:59Z', onFetch: (state) => { state.now = Date.parse('2024-02-29T15:00:00Z') } })
  assert.deepEqual(result, { ok: false, code: 'period-changed' })
})

test('guards wrong origin, non-console pages and missing team without requests', async () => {
  for (const options of [{ origin: 'https://evil.example' }, { path: '/login' }, { path: '/' }, { team: null }]) {
    const { result, state } = await run(options)
    assert.deepEqual(result, { ok: false, code: 'team' in options ? 'team-required' : 'page-required' })
    assert.equal(state.calls.length, 0)
  }
})

test('maps authorization, rate limit, malformed JSON and network failures without exposing responses', async () => {
  for (const [reply, code] of [
    [{ status: 401, body: 'private-synthetic' }, 'login-required'],
    [{ status: 403 }, 'login-required'],
    [{ status: 429 }, 'rate-limited'],
    [{ invalidJson: true }, 'unexpected-response'],
    [{ status: 500 }, 'network-error'],
  ] as const) {
    const { result } = await run({ replies: [reply] })
    assert.deepEqual(result, { ok: false, code })
    assert.equal(JSON.stringify(result).includes('private-synthetic'), false)
  }
  assert.deepEqual((await run({ replies: [] })).result, { ok: false, code: 'network-error' })
})

test('missing login and account switch during token retrieval send no requests', async () => {
  const loggedOut = await run({ loggedOut: true })
  assert.deepEqual(loggedOut.result, { ok: false, code: 'login-required' })
  assert.equal(loggedOut.state.calls.length, 0)
  const switched = await run({ onToken: (state) => { state.team = 'other-synthetic' } })
  assert.deepEqual(switched.result, { ok: false, code: 'account-changed' })
  assert.equal(switched.state.calls.length, 0)
})

test('first identity probe is opaque and makes no token or network requests', async () => {
  const first = await run({ expectedIdentity: null })
  const second = await run({ expectedIdentity: null, sessionId: 'new-session-synthetic' })
  assert.deepEqual(first.result, second.result)
  const result = first.result as { ok: boolean; code: string; identityKey: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'connection-required')
  assert.equal(/^[0-9a-f]{64}$/.test(result.identityKey), true)
  assert.equal(first.state.tokens, 0)
  assert.equal(first.state.calls.length, 0)
  assert.equal(JSON.stringify(result).includes('synthetic'), false)
  const bound = await run({ expectedIdentity: result.identityKey, sessionId: 'new-session-synthetic' })
  assert.equal((bound.result as { ok: boolean }).ok, true)
})

test('different user or team and invalid keys are rejected before credentials or requests', async () => {
  for (const options of [
    { userId: 'other-user-synthetic' }, { team: 'other-team-synthetic' },
    { expectedIdentity: 'not-a-fingerprint' },
  ]) {
    const { result, state } = await run(options)
    assert.deepEqual(result, { ok: false, code: 'expectedIdentity' in options ? 'unexpected-response' : 'account-changed' })
    assert.equal(state.tokens, 0)
    assert.equal(state.calls.length, 0)
  }
})

test('identity changes while hashing abort both probe and collection', async () => {
  for (const expectedIdentity of [null, undefined]) {
    for (const change of [
      (s: Harness) => { s.team = 'other-team-synthetic' },
      (s: Harness) => { if (s.user) s.user.id = 'other-user-synthetic' },
      (s: Harness) => { if (s.session) s.session.id = 'other-session-synthetic' },
    ]) {
      const { result, state } = await run({ expectedIdentity, onDigest: change })
      assert.deepEqual(result, { ok: false, code: 'account-changed' })
      assert.equal(state.tokens, 0)
      assert.equal(state.calls.length, 0)
    }
  }
})

test('a newly loading Clerk can become ready before the identity probe', async () => {
  const { result, state } = await run({ expectedIdentity: null, readyAfter: 2 })
  assert.equal(typeof result === 'object' && result !== null && 'code' in result && result.code, 'connection-required')
  assert.equal(state.tokens, 0)
  assert.equal(state.calls.length, 0)
})
