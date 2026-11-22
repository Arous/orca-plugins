import { assert, test } from 'orca/testing'
import { collectAdvisor, expandHomePath, parseAdvisorPayload } from './advisor'
import {
  codex429AdvisorPayload,
  expiringAdvisorPayload,
  liveAdvisorPayload,
  newSubAdvisorPayload
} from './fixtures'
import { formatPaygSummary, formatQuotaSummary, formatTaskCost, statusBarText } from './format'
import { readyConsoleState } from './fixtures'

test('parses valid shared JSON v1 payloads across live, 429 fallback, newSub, and D-3 variants', () => {
  for (const sample of [
    liveAdvisorPayload,
    codex429AdvisorPayload,
    newSubAdvisorPayload,
    expiringAdvisorPayload
  ]) {
    const parsed = parseAdvisorPayload(JSON.stringify(sample))
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.payload.schemaVersion, 1)
      assert.equal(parsed.payload.deskModel.active, sample.deskModel.active)
      assert.equal(parsed.payload.quotas.length, sample.quotas.length)
      assert.deepEqual(parsed.payload.unmappedActiveProviders, sample.unmappedActiveProviders)
    }
  }
})

test('degrades cleanly on invalid JSON or unsupported schemaVersion without throwing', () => {
  const badJson = parseAdvisorPayload('{not-json')
  assert.equal(badJson.ok, false)
  if (!badJson.ok) {
    assert.equal(badJson.code, 'invalid-json')
    assert.equal(badJson.payload, null)
  }

  const badVersion = parseAdvisorPayload(JSON.stringify({ ...liveAdvisorPayload, schemaVersion: 2 }))
  assert.equal(badVersion.ok, false)
  if (!badVersion.ok) {
    assert.equal(badVersion.code, 'invalid-schema')
    assert.equal(badVersion.payload, null)
  }
})

test('collectAdvisor expands ~ and handles missing script, non-zero exit, and timeout gracefully', async () => {
  assert.equal(
    expandHomePath('~/.orca/bots/intake-desk/scripts/route-advisor.mjs', '/Users/tester'),
    '/Users/tester/.orca/bots/intake-desk/scripts/route-advisor.mjs'
  )

  const seen: { cmd: string; args: string[] }[] = []
  const okResult = await collectAdvisor(
    '~/.orca/bots/intake-desk/scripts/route-advisor.mjs',
    new AbortController().signal,
    async (cmd, args) => {
      seen.push({ cmd, args })
      return { exitCode: 0, stdout: JSON.stringify(liveAdvisorPayload), stderr: '' }
    }
  )
  assert.equal(okResult.ok, true)
  assert.ok(seen[0]?.args[0]?.endsWith('/.orca/bots/intake-desk/scripts/route-advisor.mjs'))
  assert.equal(seen[0]?.args[1], '--json')

  const missingResult = await collectAdvisor(
    '/nonexistent/route-advisor.mjs',
    new AbortController().signal,
    async () => ({ exitCode: null, stdout: '', stderr: 'ENOENT', errorCode: 'ENOENT' })
  )
  assert.equal(missingResult.ok, false)
  if (!missingResult.ok) assert.equal(missingResult.code, 'missing-script')

  const timeoutResult = await collectAdvisor(
    '/tmp/route-advisor.mjs',
    new AbortController().signal,
    async () => ({ exitCode: null, stdout: '', stderr: '', errorCode: 'ETIMEDOUT' })
  )
  assert.equal(timeoutResult.ok, false)
  if (!timeoutResult.ok) assert.equal(timeoutResult.code, 'timeout')

  const failedResult = await collectAdvisor(
    '/tmp/route-advisor.mjs',
    new AbortController().signal,
    async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })
  )
  assert.equal(failedResult.ok, false)
  if (!failedResult.ok) assert.equal(failedResult.code, 'exec-failed')
})

test('formats quota, PAYG, cost, and status bar summary', () => {
  assert.equal(formatQuotaSummary(liveAdvisorPayload.quotas[0]), '주간 9%')
  assert.equal(formatQuotaSummary(liveAdvisorPayload.quotas[2]), '5h 66% · 주간 53%')
  assert.equal(formatPaygSummary(liveAdvisorPayload.payg.opengateway), '24h $25.83 · 7d $223.00')
  assert.equal(formatTaskCost('subscription', 0), '구독 $0')
  assert.equal(formatTaskCost('payg', 0.08), '종량제 ~$0.08')
  assert.equal(statusBarText(readyConsoleState), 'Desk 대기 1 · 워커 2')
})

test('normalizes unknown quota status, track, worktreeMode, and preserves optional worktree', () => {
  const payload = {
    ...liveAdvisorPayload,
    quotas: [{ ...liveAdvisorPayload.quotas[0], status: 'mystery_state' }],
    recommendation: {
      ...liveAdvisorPayload.recommendation!,
      track: 'track99',
      worktreeMode: 'custom_mode',
      worktree: 'desk-existing-wt'
    }
  }
  const parsed = parseAdvisorPayload(JSON.stringify(payload))
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.payload.quotas[0]?.status, 'unknown')
    assert.equal(parsed.payload.recommendation?.track, 'track2')
    assert.equal(parsed.payload.recommendation?.worktreeMode, 'new')
    assert.equal(parsed.payload.recommendation?.worktree, 'desk-existing-wt')
  }
})
