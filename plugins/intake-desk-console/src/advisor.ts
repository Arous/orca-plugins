import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type {
  AdvisorAlternative,
  AdvisorDeskModel,
  AdvisorFallbackEntry,
  AdvisorPaygEntry,
  AdvisorPayload,
  AdvisorQuota,
  AdvisorQuotaStatus,
  AdvisorRecommendation,
  BillingType,
  ModelOption,
  PendingQueueFileItem,
  RecommendationTrack,
  WorktreeMode
} from './protocol'

const ADVISOR_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 512 * 1024

export type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { signal: AbortSignal; timeoutMs: number }
) => Promise<CommandResult>

export type AdvisorFailureCode =
  | 'missing-script'
  | 'exec-failed'
  | 'timeout'
  | 'cancelled'
  | 'invalid-json'
  | 'invalid-schema'

export type AdvisorCollectResult =
  | { ok: true; payload: AdvisorPayload }
  | { ok: false; code: AdvisorFailureCode; error: string; payload: null }

export function expandHomePath(inputPath: string, homeDir = homedir()): string {
  const trimmed = inputPath.trim()
  if (trimmed === '~') return homeDir
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homeDir, trimmed.slice(2))
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBillingType(value: unknown): BillingType {
  return value === 'payg' ? 'payg' : 'subscription'
}

const KNOWN_QUOTA_STATUSES: ReadonlySet<AdvisorQuotaStatus> = new Set([
  'ok',
  'rate_limited',
  'exhausted',
  'expiring',
  'expired',
  'unavailable',
  'unknown'
])

function asQuotaStatus(value: unknown): AdvisorQuotaStatus {
  if (typeof value !== 'string') return 'ok'
  return KNOWN_QUOTA_STATUSES.has(value as AdvisorQuotaStatus)
    ? (value as AdvisorQuotaStatus)
    : 'unknown'
}

function asRecommendationTrack(value: unknown): RecommendationTrack {
  if (typeof value === 'string' && value.trim().toLowerCase().replace(/\s+/g, '') === 'track3') {
    return 'track3'
  }
  return 'track2'
}

function asWorktreeMode(value: unknown): WorktreeMode {
  return value === 'existing' ? 'existing' : 'new'
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

function parseFallbackChain(raw: unknown): AdvisorFallbackEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: AdvisorFallbackEntry[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    out.push({
      agent: asString(entry.agent),
      model: asString(entry.model),
      effort: asString(entry.effort)
    })
  }
  return out
}

function parseDeskModel(raw: unknown): AdvisorDeskModel | null {
  if (!isRecord(raw)) return null
  const active = asNullableString(raw.active)
  const effort = asNullableString(raw.effort)
  const fallbackChain = parseFallbackChain(raw.fallbackChain)
  if (!active || !effort || fallbackChain === null) return null
  return {
    active,
    effort,
    fallbackActive: Boolean(raw.fallbackActive),
    fallbackChain
  }
}

function parseQuotas(raw: unknown): AdvisorQuota[] | null {
  if (!Array.isArray(raw)) return null
  const out: AdvisorQuota[] = []
  for (const item of raw) {
    if (!isRecord(item)) return null
    const id = asNullableString(item.id)
    const provider = asNullableString(item.provider)
    const label = asNullableString(item.label)
    if (!id || !provider || !label) return null
    out.push({
      id,
      provider,
      label,
      billingType: asBillingType(item.billingType),
      status: asQuotaStatus(item.status),
      sessionUsedPct: asNullableNumber(item.sessionUsedPct),
      weeklyUsedPct: asNullableNumber(item.weeklyUsedPct),
      monthlyUsedPct: asNullableNumber(item.monthlyUsedPct),
      paceRatio: asNullableNumber(item.paceRatio),
      resetsAt: asNullableString(item.resetsAt),
      resetLabel: asNullableString(item.resetLabel),
      expiresAt: asNullableString(item.expiresAt),
      burnDownBonus: asNumber(item.burnDownBonus, 0)
    })
  }
  return out
}

function parsePayg(raw: unknown): Record<string, AdvisorPaygEntry> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, AdvisorPaygEntry> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) return null
    out[key] = {
      provider: asString(entry.provider, key),
      label: asString(entry.label, key),
      last24hUsd: asNumber(entry.last24hUsd, 0),
      last7dUsd: asNumber(entry.last7dUsd, 0),
      estimateKind: asString(entry.estimateKind, 'list-price-estimate'),
      warningCap: asNullableNumber(entry.warningCap)
    }
  }
  return out
}

function parseAlternatives(raw: unknown): AdvisorAlternative[] {
  if (!Array.isArray(raw)) return []
  const out: AdvisorAlternative[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const routeId = asNullableString(item.routeId)
    const agent = asNullableString(item.agent)
    const model = asNullableString(item.model)
    if (!routeId || !agent || !model) continue
    out.push({
      routeId,
      shortAlias: asString(item.shortAlias, agent),
      agent,
      model,
      effort: asString(item.effort, 'medium'),
      score: asNumber(item.score, 0),
      billingType: asBillingType(item.billingType)
    })
  }
  return out
}

function parseRecommendation(raw: unknown): AdvisorRecommendation | null | undefined {
  if (raw === null || raw === undefined) return null
  if (!isRecord(raw)) return undefined
  const taskId = asNullableString(raw.taskId)
  const routeId = asNullableString(raw.routeId)
  const agent = asNullableString(raw.agent)
  const model = asNullableString(raw.model)
  if (!taskId || !routeId || !agent || !model) return undefined
  return {
    taskId,
    domain: asNullableString(raw.domain),
    track: asRecommendationTrack(raw.track),
    worktreeMode: asWorktreeMode(raw.worktreeMode),
    worktree: asNullableString(raw.worktree),
    routeId,
    agent,
    model,
    effort: asString(raw.effort, 'medium'),
    billingType: asBillingType(raw.billingType),
    estimatedCostUsd: asNumber(raw.estimatedCostUsd, 0),
    estimatedMinutes: asNumber(raw.estimatedMinutes, 10),
    score: asNumber(raw.score, 0),
    reason: asString(raw.reason),
    oneLine: asString(raw.oneLine),
    alternatives: parseAlternatives(raw.alternatives)
  }
}

export function parseAdvisorPayload(raw: string): AdvisorCollectResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      code: 'invalid-json',
      error: 'route-advisor 출력이 올바른 JSON이 아닙니다.',
      payload: null
    }
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return {
      ok: false,
      code: 'invalid-schema',
      error: 'route-advisor JSON 계약 버전(v1)과 일치하지 않습니다.',
      payload: null
    }
  }

  const generatedAt = asNullableString(parsed.generatedAt)
  const deskModel = parseDeskModel(parsed.deskModel)
  const quotas = parseQuotas(parsed.quotas)
  const payg = parsePayg(parsed.payg)
  const unmappedActiveProviders = asStringArray(parsed.unmappedActiveProviders)
  const excludedProviders = asStringArray(parsed.excludedProviders)
  const recommendation = parseRecommendation(parsed.recommendation)
  const errors = asStringArray(parsed.errors)

  if (
    !generatedAt ||
    !deskModel ||
    !quotas ||
    !payg ||
    !unmappedActiveProviders ||
    !excludedProviders ||
    recommendation === undefined ||
    !errors
  ) {
    return {
      ok: false,
      code: 'invalid-schema',
      error: 'route-advisor JSON 스키마 필드가 누락되었거나 형식이 잘못되었습니다.',
      payload: null
    }
  }

  return {
    ok: true,
    payload: {
      schemaVersion: 1,
      generatedAt,
      deskModel,
      quotas,
      payg,
      unmappedActiveProviders,
      excludedProviders,
      recommendation,
      errors
    }
  }
}

export const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  if (command === process.execPath && args[0]) {
    try {
      await access(args[0])
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ENOENT'
      return { exitCode: null, stdout: '', stderr: String(error), errorCode: code }
    }
  }

  return new Promise<CommandResult>((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timer: NodeJS.Timeout | undefined

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }

    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ exitCode: null, stdout, stderr, errorCode: 'ECANCELLED' })
    }

    if (options.signal.aborted) {
      onAbort()
      return
    }
    options.signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: null, stdout, stderr, errorCode: 'ETIMEDOUT' })
    }, options.timeoutMs)

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr: error.message,
        errorCode: error.code ?? 'EEXEC'
      })
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish({ exitCode: null, stdout: '', stderr: 'output exceeded limit', errorCode: 'ETOOBIG' })
        return
      }
      stdout += chunk
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk
    })

    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr })
    })
  })
}

export async function collectAdvisor(
  scriptPath: string,
  signal: AbortSignal,
  runner: CommandRunner = defaultCommandRunner
): Promise<AdvisorCollectResult> {
  const trimmed = scriptPath.trim()
  if (!trimmed) {
    return {
      ok: false,
      code: 'missing-script',
      error: 'route-advisor 스크립트 경로가 비어 있습니다.',
      payload: null
    }
  }

  const resolvedPath = expandHomePath(trimmed)
  try {
    const result = await runner(process.execPath, [resolvedPath, '--json'], {
      signal,
      timeoutMs: ADVISOR_TIMEOUT_MS
    })

    if (result.errorCode === 'ECANCELLED' || signal.aborted) {
      return {
        ok: false,
        code: 'cancelled',
        error: 'route-advisor 조회가 취소되었습니다.',
        payload: null
      }
    }

    if (result.errorCode === 'ETIMEDOUT') {
      return {
        ok: false,
        code: 'timeout',
        error: 'route-advisor 실행 시간이 초과되었습니다.',
        payload: null
      }
    }

    if (
      result.errorCode === 'ENOENT' ||
      result.stderr.includes('ENOENT') ||
      result.stderr.includes('Cannot find module')
    ) {
      return {
        ok: false,
        code: 'missing-script',
        error: 'route-advisor 스크립트를 찾을 수 없습니다.',
        payload: null
      }
    }

    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'exec-failed',
        error: `route-advisor 실행에 실패했습니다 (exit ${result.exitCode ?? 'unknown'}).`,
        payload: null
      }
    }

    return parseAdvisorPayload(result.stdout)
  } catch {
    return {
      ok: false,
      code: 'exec-failed',
      error: 'route-advisor 실행 중 예기치 않은 오류가 발생했습니다.',
      payload: null
    }
  }
}

function parsePendingOptions(raw: unknown): ModelOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ModelOption[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const modelId = asNullableString(entry.modelId)
    const routeId = asNullableString(entry.routeId)
    const agent = asNullableString(entry.agent)
    const model = asNullableString(entry.model)
    if (!modelId || !routeId || !agent || !model) continue
    out.push({
      modelId,
      routeId,
      shortAlias: asString(entry.shortAlias, agent),
      agent,
      model,
      effort: asString(entry.effort, 'medium'),
      billingType: asBillingType(entry.billingType),
      label: asString(entry.label, `${agent} / ${model}`)
    })
  }
  return out
}

export function parsePendingQueueFileItems(raw: unknown): PendingQueueFileItem[] {
  let rawItems: unknown = raw
  if (isRecord(raw)) {
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) return []
    rawItems = raw.items
  }
  if (!Array.isArray(rawItems)) return []

  const items: PendingQueueFileItem[] = []
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue
    const taskId = asNullableString(entry.taskId)?.trim()
    const domain = asNullableString(entry.domain)?.trim()
    const worktreeName = asNullableString(entry.worktreeName)?.trim()
    const title = asNullableString(entry.title)?.trim()
    const spec = asNullableString(entry.spec)?.trim()
    const agent = asNullableString(entry.agent)?.trim()
    const model = asNullableString(entry.model)?.trim()
    if (!taskId || !domain || !worktreeName || !title || !spec || !agent || !model) continue

    items.push({
      taskId,
      domain,
      projectId: asNullableString(entry.projectId),
      workspaceId: asNullableString(entry.workspaceId),
      track: asRecommendationTrack(entry.track),
      worktreeMode: asWorktreeMode(entry.worktreeMode),
      worktreeName,
      title,
      spec,
      agent,
      model,
      effort: asString(entry.effort, 'medium'),
      billingType: asBillingType(entry.billingType),
      estimatedCostUsd: asNumber(entry.estimatedCostUsd, 0),
      estimatedMinutes: asNumber(entry.estimatedMinutes, 15),
      reason: asString(entry.reason),
      oneLine: asString(entry.oneLine),
      options: parsePendingOptions(entry.options),
      createdAt: asNumber(entry.createdAt, 0)
    })
  }
  return items
}

export async function readPendingQueueFile(queuePath: string): Promise<PendingQueueFileItem[]> {
  const trimmed = queuePath.trim()
  if (!trimmed) return []
  const resolved = expandHomePath(trimmed)
  try {
    const text = await readFile(resolved, 'utf8')
    return parsePendingQueueFileItems(JSON.parse(text))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    return []
  }
}

export async function removePendingQueueItemFile(queuePath: string, taskId: string): Promise<void> {
  const trimmed = queuePath.trim()
  if (!trimmed) return
  const resolved = expandHomePath(trimmed)
  let rawText: string
  try {
    rawText = await readFile(resolved, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return
  }

  const nextItems = parsePendingQueueFileItems(parsed).filter((item) => item.taskId !== taskId)
  const payload = `${JSON.stringify(
    {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      items: nextItems
    },
    null,
    2
  )}\n`

  await mkdir(dirname(resolved), { recursive: true })
  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmpPath, payload, { mode: 0o600 })
    await rename(tmpPath, resolved)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}
