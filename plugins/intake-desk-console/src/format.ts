import type {
  AdvisorPaygEntry,
  AdvisorQuota,
  AdvisorQuotaStatus,
  BillingType,
  ConsoleState,
  ConsoleStatus,
  WorkerBoardStatus,
  WorkerItem
} from './protocol'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const CONSOLE_STATUS_META: Record<ConsoleStatus, { label: string; tone: Tone }> = {
  loading: { label: '확인 중', tone: 'neutral' },
  ready: { label: '정상', tone: 'success' },
  stale: { label: '지연', tone: 'warning' },
  error: { label: '오류', tone: 'danger' }
}

const WORKER_STATUS_META: Record<WorkerBoardStatus, { label: string; tone: Tone }> = {
  working: { label: '진행 중', tone: 'accent' },
  permission: { label: '확인 필요', tone: 'danger' },
  done: { label: '검수 대기', tone: 'success' },
  handoff: { label: '핸드오프', tone: 'accent' },
  active: { label: '활성', tone: 'neutral' },
  inactive: { label: '대기', tone: 'warning' }
}

export function consoleStatusLabel(status: ConsoleStatus): string {
  return CONSOLE_STATUS_META[status].label
}

export function consoleStatusTone(status: ConsoleStatus): Tone {
  return CONSOLE_STATUS_META[status].tone
}

export function workerStatusLabel(status: WorkerBoardStatus): string {
  return WORKER_STATUS_META[status].label
}

export function workerStatusTone(status: WorkerBoardStatus): Tone {
  return WORKER_STATUS_META[status].tone
}

export function quotaDisplayPct(quota: AdvisorQuota): number {
  const candidates = [quota.sessionUsedPct, quota.weeklyUsedPct, quota.monthlyUsedPct].filter(
    (value): value is number => value !== null && Number.isFinite(value)
  )
  if (candidates.length === 0) return 0
  return Math.max(0, Math.min(100, Math.round(Math.max(...candidates))))
}

export function quotaTone(quota: AdvisorQuota): Tone {
  const pct = quotaDisplayPct(quota)
  if (quota.status !== 'ok' || pct >= 95) return 'danger'
  if (quota.burnDownBonus > 0 || (quota.paceRatio !== null && quota.paceRatio >= 1.2) || pct >= 70) {
    return 'warning'
  }
  return 'success'
}

const QUOTA_STATUS_META: Record<AdvisorQuotaStatus, string> = {
  ok: '정상',
  rate_limited: '한도 제한',
  exhausted: '한도 소진',
  expiring: '만료 임박',
  expired: '만료됨',
  unavailable: '미연결',
  unknown: '상태 확인 필요'
}

export function quotaStatusLabel(status: AdvisorQuotaStatus): string {
  return QUOTA_STATUS_META[status] ?? '상태 확인 필요'
}

export function formatQuotaSummary(quota: AdvisorQuota): string {
  const parts: string[] = []
  if (quota.sessionUsedPct !== null) parts.push(`5h ${Math.round(quota.sessionUsedPct)}%`)
  if (quota.weeklyUsedPct !== null) parts.push(`주간 ${Math.round(quota.weeklyUsedPct)}%`)
  if (quota.monthlyUsedPct !== null) parts.push(`월간 ${Math.round(quota.monthlyUsedPct)}%`)
  if (quota.burnDownBonus > 0) parts.push(`Burn-down +${quota.burnDownBonus}`)
  return parts.join(' · ') || quotaStatusLabel(quota.status)
}

export function formatQuotaMeta(quota: AdvisorQuota): string {
  const parts: string[] = []
  if (quota.resetLabel) parts.push(quota.resetLabel)
  if (quota.paceRatio !== null) {
    parts.push(`페이스 ${quota.paceRatio.toFixed(2)}x`)
  }
  if (quota.status !== 'ok') {
    const label = quotaStatusLabel(quota.status)
    return parts.length > 0 ? `${label} · ${parts.join(' · ')}` : label
  }
  return parts.join(' · ') || '여유'
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '$0'
  return `$${amount.toFixed(2)}`
}

export function formatPaygSummary(entry: AdvisorPaygEntry): string {
  return `24h ${formatUsd(entry.last24hUsd)} · 7d ${formatUsd(entry.last7dUsd)}`
}

export function formatTaskCost(billingType: BillingType, costUsd: number): string {
  if (billingType === 'subscription') return `구독 ${formatUsd(costUsd)}`
  return `종량제 ~${formatUsd(costUsd)}`
}

export function isDeskOrActiveWorker(worker: WorkerItem): boolean {
  return worker.isDeskOwned || worker.isActive
}

export function statusBarText(state: ConsoleState): string {
  const activeCount = state.workers.filter(isDeskOrActiveWorker).length
  if (state.status === 'error' && !state.advisor) return 'Desk 오류'
  if (state.status === 'loading' && !state.advisor && activeCount === 0) return 'Desk 확인 중'
  const prefix = state.advisor?.deskModel.fallbackActive ? 'Desk 폴백' : 'Desk'
  return `${prefix} 대기 ${state.pending.length} · 워커 ${activeCount}`
}

export function statusBarTooltip(state: ConsoleState): string {
  const activeCount = state.workers.filter(isDeskOrActiveWorker).length
  const lines: string[] = []
  if (state.advisor) {
    lines.push(
      `메인 모델: ${state.advisor.deskModel.active} (${state.advisor.deskModel.effort})${
        state.advisor.deskModel.fallbackActive ? ' [폴백]' : ''
      }`
    )
  }
  lines.push(
    `승인 대기 ${state.pending.length}건 · Desk/활성 워커 ${activeCount}건 (전체 ${state.workers.length}건)`
  )
  if (state.error) lines.push(state.error)
  return lines.join('\n')
}
