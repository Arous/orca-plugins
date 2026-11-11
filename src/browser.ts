import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { collectUsage } from './collector'
import type { BrowserBridge, BrowserTarget, CollectionError, CollectionResult } from './protocol'

const CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const ORIGIN = 'https://opengateway.ai'
const USAGE_URL = `${ORIGIN}/analysis`
const execute = promisify(execFile)
const ERROR_CODES: CollectionError[] = [
  'login-required', 'page-required', 'team-required', 'account-changed',
  'period-changed', 'rate-limited', 'unavailable', 'unexpected-response', 'network-error'
]
const IDENTITY = /^[0-9a-f]{64}$/

type Tab = { tabId: string; profileId: string | null; worktreeId: string; url: string }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value &&
  !value.startsWith('-') && !/[\r\n\0]/.test(value)

async function run(args: string[], signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new Error('Orca browser command cancelled')
  let stdout: string
  try {
    const result = await execute(CLI, [...args, '--environment', 'local', '--json'], {
      timeout: 40_000, maxBuffer: 1_048_576, signal,
      cwd: '/tmp', encoding: 'utf8'
    })
    stdout = result.stdout
  } catch {
    throw new Error('Orca browser command failed')
  }
  if (signal.aborted) throw new Error('Orca browser command cancelled')
  let envelope: unknown
  try { envelope = JSON.parse(stdout) } catch { throw new Error('Invalid Orca response') }
  if (!object(envelope) || envelope.ok !== true || !object(envelope.result)) {
    throw new Error('Orca browser command refused')
  }
  return envelope.result
}

async function tabs(signal: AbortSignal): Promise<Tab[]> {
  const result = await run(['tab', 'list', '--worktree', 'all', '--show-profile'], signal)
  if (!Array.isArray(result.tabs)) throw new Error('Invalid tab list')
  return result.tabs.map((row: unknown) => {
    if (!object(row) || !identifier(row.browserPageId) ||
        !(row.profileId === null || identifier(row.profileId)) ||
        !identifier(row.worktreeId) || typeof row.url !== 'string') throw new Error('Invalid tab metadata')
    return { tabId: row.browserPageId, profileId: row.profileId, worktreeId: row.worktreeId, url: row.url }
  })
}

function originUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.origin === ORIGIN && !url.username && !url.password ? url : null
  } catch { return null }
}

function validTarget(target: BrowserTarget): boolean {
  return identifier(target.tabId) && identifier(target.profileId) && identifier(target.worktreeId)
}

function inScope(tab: Tab, target: BrowserTarget): boolean {
  return tab.tabId === target.tabId && tab.profileId === target.profileId && tab.worktreeId === target.worktreeId
}

async function resolveProfile(tab: Tab, signal: AbortSignal): Promise<Tab> {
  if (tab.profileId !== null) return tab
  const profile = await run(['tab', 'profile', 'show', '--page', tab.tabId], signal)
  if (profile.browserPageId !== tab.tabId || profile.worktreeId !== tab.worktreeId || !identifier(profile.profileId)) {
    throw new Error('Unresolved tab profile')
  }
  const observed = (await tabs(signal)).find((row) => row.tabId === tab.tabId)
  if (!observed || observed.worktreeId !== tab.worktreeId || observed.profileId !== profile.profileId ||
      !originUrl(observed.url)) throw new Error('Unresolved tab profile')
  return observed
}

async function createTab(target: BrowserTarget | null, signal: AbortSignal): Promise<BrowserTarget> {
  const profileId = target?.profileId ?? 'default'
  const args = ['tab', 'create', '--url', USAGE_URL, '--profile', profileId]
  if (target) args.push('--worktree', target.worktreeId.startsWith('folder:') ? target.worktreeId : `id:${target.worktreeId}`)
  const created = await run(args, signal)
  if (!identifier(created.browserPageId)) throw new Error('Invalid created tab')
  const found = (await tabs(signal)).find((tab) => tab.tabId === created.browserPageId)
  if (!found || !originUrl(found.url)) throw new Error('Invalid created tab scope')
  const observed = await resolveProfile(found, signal)
  if (observed.profileId !== profileId || (target && observed.worktreeId !== target.worktreeId)) {
    throw new Error('Invalid created tab scope')
  }
  return { tabId: observed.tabId, profileId: observed.profileId, worktreeId: observed.worktreeId }
}

async function current(target: BrowserTarget, signal: AbortSignal): Promise<Tab | null> {
  if (!validTarget(target)) throw new Error('Invalid tab target')
  const found = (await tabs(signal)).find((tab) => tab.tabId === target.tabId)
  if (!found) return null
  if (found.worktreeId !== target.worktreeId) throw new Error('Tab scope changed')
  if (!originUrl(found.url)) return found
  const observed = await resolveProfile(found, signal)
  if (!inScope(observed, target)) throw new Error('Tab scope changed')
  return observed
}

export const browserBridge: BrowserBridge = {
  async ensureTab(target, legacyTabId, signal) {
    if (target && !validTarget(target)) throw new Error('Invalid tab target')
    const all = await tabs(signal)
    const found = all.find((tab) => tab.tabId === (target?.tabId ?? legacyTabId))
    if (found && target && found.worktreeId !== target.worktreeId) throw new Error('Tab scope changed')
    if (found && originUrl(found.url)) {
      const existing = await resolveProfile(found, signal)
      if (target && !inScope(existing, target)) throw new Error('Tab scope changed')
      const url = originUrl(existing.url)
      if (!url || !identifier(existing.profileId)) throw new Error('Invalid tab metadata')
      if (!['/', '/login', '/dashboard', '/analysis'].includes(url.pathname)) {
        await run(['goto', '--page', existing.tabId, '--expect-url', existing.url, '--url', USAGE_URL], signal)
      }
      return { tabId: existing.tabId, profileId: existing.profileId, worktreeId: existing.worktreeId }
    }
    return createTab(target, signal)
  },
  async revealTab(target, signal) {
    const tab = await current(target, signal)
    if (!tab || !originUrl(tab.url)) throw new Error('Owned tab unavailable')
    await run(['tab', 'switch', '--page', tab.tabId, '--focus'], signal)
    const url = originUrl(tab.url)
    if (url && !['/dashboard', '/analysis'].includes(url.pathname)) {
      await run(['goto', '--page', tab.tabId, '--expect-url', tab.url, '--url', USAGE_URL], signal)
    }
  },
  async collect(target, identityKey, signal) {
    if (identityKey !== null && (typeof identityKey !== 'string' || !IDENTITY.test(identityKey))) {
      return { ok: false, code: 'unexpected-response' }
    }
    const tab = await current(target, signal)
    const url = tab && originUrl(tab.url)
    if (!tab || !url || !['/dashboard', '/analysis'].includes(url.pathname)) {
      return { ok: false, code: 'page-required' }
    }
    const response = await run([
      'eval', '--page', tab.tabId, '--expect-url', tab.url,
      '--expression', `(${collectUsage.toString()})(${JSON.stringify(identityKey)})`
    ], signal)
    let result: unknown = response.result
    if (typeof result === 'string') {
      try { result = JSON.parse(result) } catch { return { ok: false, code: 'unexpected-response' } }
    }
    if (!object(result)) return { ok: false, code: 'unexpected-response' }
    if (result.ok === false && result.code === 'connection-required') {
      return identityKey === null && typeof result.identityKey === 'string' && IDENTITY.test(result.identityKey)
        ? { ok: false, code: 'connection-required', identityKey: result.identityKey }
        : { ok: false, code: 'unexpected-response' }
    }
    if (result.ok === false && ERROR_CODES.includes(result.code as CollectionError)) {
      return { ok: false, code: result.code as CollectionError }
    }
    const snapshot = result.snapshot
    if (identityKey === null || result.ok !== true || !object(snapshot) ||
      !['balanceUsd', 'todayUsd', 'monthUsd', 'updatedAt'].every(
        (key) => typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key])
      ) || typeof snapshot.periodDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.periodDay) ||
      typeof snapshot.periodMonth !== 'string' || !/^\d{4}-\d{2}$/.test(snapshot.periodMonth)) {
      return { ok: false, code: 'unexpected-response' }
    }
    return {
      ok: true,
      snapshot: {
        balanceUsd: snapshot.balanceUsd as number,
        todayUsd: snapshot.todayUsd as number,
        monthUsd: snapshot.monthUsd as number,
        updatedAt: snapshot.updatedAt as number,
        periodDay: snapshot.periodDay,
        periodMonth: snapshot.periodMonth
      }
    }
  },
}
