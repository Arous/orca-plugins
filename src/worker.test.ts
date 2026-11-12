import { assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { createWorker } from './worker'
import type { BrowserBridge, BrowserTarget, CollectionResult, SavedConnection, UsageState } from './protocol'

const FIRST_IDENTITY = 'a'.repeat(64)
const SECOND_IDENTITY = 'b'.repeat(64)
const TARGET: BrowserTarget = { tabId: 'owned-1', profileId: 'profile-original', worktreeId: 'workspace-original' }
const BOUND: SavedConnection = { ...TARGET, identityKey: FIRST_IDENTITY }

class Browser implements BrowserBridge {
  live: BrowserTarget | null = null
  identity = FIRST_IDENTITY
  created = 0
  accountingReads = 0
  changeScope = false
  beforeProbe: (() => Promise<void>) | null = null

  close(): void {
    this.live = null
  }

  async ensureTab(target: BrowserTarget | null, legacyTabId: string | null, signal: AbortSignal): Promise<BrowserTarget> {
    signal.throwIfAborted()
    if (this.changeScope) return { ...TARGET, profileId: 'foreign-profile' }
    if (this.live && (this.live.tabId === target?.tabId || this.live.tabId === legacyTabId)) return { ...this.live }
    this.created += 1
    this.live = {
      tabId: `owned-${this.created + 1}`,
      profileId: target?.profileId ?? TARGET.profileId,
      worktreeId: target?.worktreeId ?? TARGET.worktreeId
    }
    return { ...this.live }
  }

  async revealTab(_target: BrowserTarget, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
  }

  async collect(_target: BrowserTarget, identityKey: string | null, signal: AbortSignal): Promise<CollectionResult> {
    signal.throwIfAborted()
    if (identityKey === null) {
      await this.beforeProbe?.()
      return { ok: false, code: 'connection-required', identityKey: this.identity }
    }
    if (identityKey !== this.identity) return { ok: false, code: 'account-changed' }
    this.accountingReads += 1
    return {
      ok: true,
      snapshot: {
        balanceUsd: 60, todayUsd: 5, monthUsd: 40,
        updatedAt: Date.parse('2024-03-15T12:00:00Z'), periodDay: '2024-03-15', periodMonth: '2024-03'
      }
    }
  }
}

async function stateOf(worker: TestWorker): Promise<UsageState> {
  for (let turn = 0; turn < 32; turn += 1) {
    const state = await worker.request('usage.get')
    if (!state.refreshing) return state
  }
  throw new Error('Synthetic worker did not settle')
}

function hostWith(connection?: SavedConnection) {
  return mockHost({
    capabilities: ['storage:own'],
    storage: connection ? { connection: { ...connection } } : { 'selected-tab-id': 'closed-legacy-page' }
  })
}

test('one confirmed connection survives a closed tab and worker reactivation without another selection', async () => {
  const browser = new Browser()
  const host = hostWith()
  let worker = await mountWorker(createWorker(browser), { host })
  try {
    const initial = await stateOf(worker)
    assert.equal(initial.status, 'connection-required')
    assert.equal(initial.snapshot, null)
    assert.equal(initial.confirmationKey, FIRST_IDENTITY)
    assert.equal(browser.accountingReads, 0)
    assert.equal(host.data().storage['selected-tab-id'], undefined)
    await worker.request('usage.connect', { identityKey: FIRST_IDENTITY })
    assert.equal((await stateOf(worker)).status, 'ready')
    const firstTarget = browser.live
    assert.ok(firstTarget)
    assert.deepEqual(host.data().storage.connection, { ...firstTarget, identityKey: FIRST_IDENTITY })

    browser.close()
    await worker.request('usage.refresh')
    const restored = await stateOf(worker)
    assert.equal(restored.status, 'ready')
    assert.equal(restored.canConnect, false)
    assert.ok(browser.live)
    assert.notEqual(browser.live.tabId, firstTarget.tabId)
    assert.equal(browser.live.profileId, firstTarget.profileId)
    assert.equal(browser.live.worktreeId, firstTarget.worktreeId)
    assert.deepEqual(host.data().storage.connection, { ...browser.live, identityKey: FIRST_IDENTITY })

    const created = browser.created
    await worker.deactivate()
    worker = await mountWorker(createWorker(browser), { host })
    const restarted = await stateOf(worker)
    assert.equal(restarted.status, 'ready')
    assert.equal(restarted.confirmationKey, null)
    assert.equal(browser.created, created)
  } finally {
    await worker.deactivate()
  }
})

test('a stale confirmation cannot authorize the currently proposed account', async () => {
  const browser = new Browser()
  const host = hostWith()
  const worker = await mountWorker(createWorker(browser), { host })
  try {
    await stateOf(worker)
    browser.identity = SECOND_IDENTITY
    await worker.request('usage.refresh')
    assert.equal((await stateOf(worker)).confirmationKey, SECOND_IDENTITY)
    await assert.rejects(worker.request('usage.connect', { identityKey: FIRST_IDENTITY }))
    assert.equal((await stateOf(worker)).status, 'connection-required')
    assert.equal(browser.accountingReads, 0)
    assert.deepEqual(host.data().storage.connection, { ...browser.live, identityKey: null })
  } finally {
    await worker.deactivate()
  }
})

test('account changes between the shown confirmation and fresh probe are not persisted', async () => {
  const browser = new Browser()
  const host = hostWith()
  const worker = await mountWorker(createWorker(browser), { host })
  try {
    assert.equal((await stateOf(worker)).confirmationKey, FIRST_IDENTITY)
    browser.identity = SECOND_IDENTITY
    await worker.request('usage.connect', { identityKey: FIRST_IDENTITY })
    const changed = await stateOf(worker)
    assert.equal(changed.confirmationKey, SECOND_IDENTITY)
    assert.equal(changed.snapshot, null)
    assert.equal(browser.accountingReads, 0)
    assert.deepEqual(host.data().storage.connection, { ...browser.live, identityKey: null })
  } finally {
    await worker.deactivate()
  }
})

test('a bound account change hides money and preserves its old pin until explicit new confirmation', async () => {
  const browser = new Browser()
  browser.live = { ...TARGET }
  const host = hostWith(BOUND)
  const worker = await mountWorker(createWorker(browser), { host })
  try {
    assert.equal((await stateOf(worker)).status, 'ready')
    const reads = browser.accountingReads
    browser.identity = SECOND_IDENTITY
    await worker.request('usage.refresh')
    const changed = await stateOf(worker)
    assert.equal(changed.status, 'connection-required')
    assert.equal(changed.snapshot, null)
    assert.equal(changed.confirmationKey, SECOND_IDENTITY)
    assert.equal(browser.accountingReads, reads)
    assert.deepEqual(host.data().storage.connection, { ...BOUND })
    await worker.request('usage.connect', { identityKey: SECOND_IDENTITY })
    assert.equal((await stateOf(worker)).status, 'ready')
    assert.deepEqual(host.data().storage.connection, { ...TARGET, identityKey: SECOND_IDENTITY })
  } finally {
    await worker.deactivate()
  }
})

test('automatic recovery cannot change the saved browser profile', async () => {
  const browser = new Browser()
  browser.changeScope = true
  const host = hostWith(BOUND)
  const worker = await mountWorker(createWorker(browser), { host })
  try {
    const state = await stateOf(worker)
    assert.equal(state.status, 'error')
    assert.equal(state.snapshot, null)
    assert.equal(browser.accountingReads, 0)
    assert.deepEqual(host.data().storage.connection, { ...BOUND })
  } finally {
    await worker.deactivate()
  }
})

test('malformed stored identity fails closed rather than creating a new unpinned connection', async () => {
  const browser = new Browser()
  const invalid = { ...BOUND, identityKey: 'not-a-fingerprint' }
  const host = mockHost({ capabilities: ['storage:own'], storage: { connection: invalid } })
  const worker = await mountWorker(createWorker(browser), { host })
  try {
    assert.equal((await stateOf(worker)).status, 'error')
    await worker.request('usage.refresh')
    assert.equal((await stateOf(worker)).status, 'error')
    assert.equal(browser.live, null)
    assert.equal(browser.accountingReads, 0)
    assert.deepEqual(host.data().storage.connection, invalid)
  } finally {
    await worker.deactivate()
  }
})

test('deactivation during confirmation cannot save a late identity or publish late money', async () => {
  const browser = new Browser()
  const host = hostWith()
  const worker = await mountWorker(createWorker(browser), { host })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await stateOf(worker)
    browser.beforeProbe = async () => { entered.resolve(); await release.promise }
    const confirmation = worker.request('usage.connect', { identityKey: FIRST_IDENTITY })
    await entered.promise
    await worker.deactivate()
    const postsAtStop = worker.posts.length
    release.resolve()
    await confirmation
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(worker.posts.length, postsAtStop)
    assert.equal(browser.accountingReads, 0)
    assert.deepEqual(host.data().storage.connection, { ...browser.live, identityKey: null })
  } finally {
    release.resolve()
    await worker.deactivate()
  }
})
