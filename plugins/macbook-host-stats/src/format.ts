import type { HostSample, HostState, HostStatus } from './protocol'

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute < 1024) return `${Math.round(value)} B`
  if (absolute < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (absolute < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${formatBytes(value)}/s`
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const STATUS_META: Record<HostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  loading: { label: '확인 중', tone: 'neutral' },
  ready: { label: '정상', tone: 'success' },
  stale: { label: '지연', tone: 'warning' },
  error: { label: '오류', tone: 'danger' }
}

export function statusLabel(status: HostStatus): string {
  return STATUS_META[status].label
}

export function statusTone(status: HostStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  return STATUS_META[status].tone
}

export function statusBarText(state: HostState): string {
  if (state.status === 'error') return 'MBP 연결 안 됨'
  if (!state.sample) return 'MBP 확인 중'
  if (state.status === 'stale') return 'MBP 연결 지연'
  return `MBP ${Math.round(state.sample.cpu.usedPercent)}% · ${Math.round(state.sample.memory.usedPercent)}% · ${Math.round(state.sample.disk.usedPercent)}%`
}

export function sampleSummary(sample: HostSample): string {
  return `CPU ${formatPercent(sample.cpu.usedPercent)} · 메모리 ${formatPercent(sample.memory.usedPercent)} · 디스크 ${formatPercent(sample.disk.usedPercent)}`
}

export function statusBarTooltip(state: HostState): string {
  const sample = state.sample
  if (!sample) {
    return `${state.host}\n${state.error ?? '자원을 확인하고 있습니다.'}`
  }
  const lines = [
    `${state.host} · ${sample.model ?? '알 수 없는 모델'}`,
    sampleSummary(sample),
    `마지막 수집 ${new Date(sample.at).toLocaleTimeString('ko-KR', { hour12: false })}`
  ]
  if (state.error) lines.push(state.error)
  return lines.join('\n')
}

export function statusSummary(state: HostState): string {
  if (state.status === 'ready' && state.sample) return sampleSummary(state.sample)
  return state.error ?? 'MacBook 자원을 확인하고 있습니다.'
}

export function batteryText(sample: HostSample): string {
  const battery = sample.battery
  if (!battery) return '—'
  const percent = battery.percent === null ? '' : `${battery.percent}%`
  const state = battery.state ?? battery.source ?? ''
  return [percent, state].filter(Boolean).join(' · ') || '—'
}
