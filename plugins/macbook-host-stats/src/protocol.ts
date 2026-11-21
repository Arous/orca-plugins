export const DEFAULT_HOST = 'macbook2015'
export const DEFAULT_POLL_SECONDS = 30
export const MIN_POLL_SECONDS = 15
export const MAX_POLL_SECONDS = 300

export type HostStatus = 'loading' | 'ready' | 'stale' | 'error'

export type CpuSample = {
  cores: number | null
  load1: number
  load5: number
  load15: number
  userPercent: number
  sysPercent: number
  idlePercent: number
  usedPercent: number
}

export type MemorySample = {
  totalBytes: number
  freeBytes: number
  activeBytes: number
  inactiveBytes: number
  speculativeBytes: number
  wiredBytes: number
  compressedBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
  swapTotalBytes: number | null
  swapUsedBytes: number | null
}

export type DiskSample = {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
}

export type NetworkSample = {
  interface: string | null
  rxBytes: number
  txBytes: number
  rxPackets: number
  txPackets: number
  rxPerSecond: number | null
  txPerSecond: number | null
}

export type BatterySample = {
  percent: number | null
  state: string | null
  source: string | null
}

export type ProcessSample = {
  pid: number
  command: string
  cpuPercent: number
  memoryPercent: number
}

export type HostSample = {
  at: number
  host: string
  model: string | null
  cpu: CpuSample
  memory: MemorySample
  disk: DiskSample
  network: NetworkSample
  uptimeSeconds: number | null
  battery: BatterySample | null
  processes: ProcessSample[]
}

export type HostState = {
  status: HostStatus
  host: string
  sample: HostSample | null
  error: string | null
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  refreshing: boolean
}

export type NetCounters = {
  at: number
  interface: string | null
  rxBytes: number
  txBytes: number
}

declare module 'orca' {
  interface PluginRequests {
    'stats.get': { output: HostState }
    'stats.refresh': { output: HostState }
  }

  interface PluginPanelEvents {
    'stats.changed': HostState
  }
}
