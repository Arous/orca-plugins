import type { UsageSnapshot } from './protocol'

const GAUGE_CELLS = 5
const FILLED = '■'
const EMPTY = '□'

const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const usdDetail = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
})
const percent = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const stamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

export type MonthShare = { ratio: number; gauge: string; percent: string }

export function formatUsd2(value: number): string {
  return Number.isFinite(value) ? usd2.format(value) : '—'
}

export function formatUsdDetail(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value !== 0 && Math.abs(value) < 0.000001) return `${value < 0 ? '-' : ''}<$0.000001`
  return usdDetail.format(value)
}

// Month spend divided by month spend plus the current balance. It is not budget or top-up utilization,
// so any operand or denominator outside the defined range yields no share instead of 0% or 100%.
export function monthShare(snapshot: Pick<UsageSnapshot, 'monthUsd' | 'balanceUsd'>): MonthShare | null {
  const { monthUsd, balanceUsd } = snapshot
  if (!Number.isFinite(monthUsd) || !Number.isFinite(balanceUsd)) return null
  if (monthUsd < 0 || balanceUsd < 0) return null
  const total = monthUsd + balanceUsd
  if (!Number.isFinite(total) || total <= 0) return null
  const ratio = monthUsd / total
  if (!(ratio >= 0 && ratio <= 1)) return null
  return { ratio, gauge: gaugeOf(ratio), percent: percentOf(ratio) }
}

export function footerText(snapshot: UsageSnapshot): string {
  const amounts = `${formatUsd2(snapshot.monthUsd)} / ${formatUsd2(snapshot.balanceUsd)}`
  const share = monthShare(snapshot)
  return share
    ? `OG 이번 달 ${amounts} [${share.gauge}] ${share.percent}`
    : `OG 이번 달 ${amounts} · 비중 —`
}

export function footerTooltip(snapshot: UsageSnapshot): string {
  const share = monthShare(snapshot)
  const updated = Number.isFinite(snapshot.updatedAt)
    ? `${stamp.format(new Date(snapshot.updatedAt))} KST`
    : '—'
  return [
    'OpenGateway · USD · Asia/Seoul',
    `이번 달 사용 ${formatUsd2(snapshot.monthUsd)} / 현재 잔액 ${formatUsd2(snapshot.balanceUsd)}`,
    `사용 비중 ${share ? share.percent : '계산 불가'} (이번 달 사용액 ÷ (이번 달 사용액 + 현재 잔액))`,
    `오늘 (${snapshot.periodDay.trim() || '—'}) ${formatUsdDetail(snapshot.todayUsd)}`,
    `기간 ${snapshot.periodMonth.trim() || '—'} (KST) · 업데이트 ${updated}`,
    '비중은 월 예산이나 최초 충전 금액 기준이 아닙니다 · 5분 자동 갱신'
  ].join('\n')
}

function gaugeOf(ratio: number): string {
  const filled = ratio >= 1
    ? GAUGE_CELLS
    : Math.min(GAUGE_CELLS - 1, Math.round(ratio * GAUGE_CELLS))
  return FILLED.repeat(filled) + EMPTY.repeat(GAUGE_CELLS - filled)
}

function percentOf(ratio: number): string {
  // Clamp just below 100 so rounding cannot claim a full share before the balance is truly exhausted.
  const value = ratio >= 1 ? 100 : Math.min(99.99, Math.round(ratio * 10000) / 100)
  return `${percent.format(value)}%`
}
