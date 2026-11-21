import { CollectorError } from './errors'
import type {
  BatterySample,
  HostSample,
  MemorySample,
  NetCounters,
  NetworkSample,
  ProcessSample
} from './protocol'

export type RemoteMetrics = {
  model: string | null
  cores: number | null
  totalMemoryBytes: number
  load: [number, number, number]
  cpu: {
    userPercent: number
    sysPercent: number
    idlePercent: number
  }
  memory: {
    pageSize: number
    freePages: number
    activePages: number
    inactivePages: number
    speculativePages: number
    wiredPages: number
    compressedPages: number
  }
  swap: {
    totalBytes: number
    usedBytes: number
  }
  disk: {
    totalBytes: number
    usedBytes: number
    availableBytes: number
    capacityPercent: number | null
  }
  network: {
    interface: string | null
    rxBytes: number | null
    txBytes: number | null
    rxPackets: number | null
    txPackets: number | null
  }
  bootTimeSeconds: number | null
  uptimeSeconds: number | null
  batteryRaw: string | null
  processes: ProcessSample[]
}

const NUMBER = /[-+]?\d+(?:\.\d+)?/g

function requiredText(fields: Map<string, string>, key: string): string {
  const value = fields.get(key)?.trim()
  if (!value) throw new CollectorError('parse-failed', `missing ${key}`)
  return value
}

function requiredNumber(fields: Map<string, string>, key: string): number {
  const parsed = optionalNumber(fields, key)
  if (parsed === null) throw new CollectorError('parse-failed', `invalid ${key}`)
  return parsed
}

function optionalNumber(fields: Map<string, string>, key: string): number | null {
  const value = fields.get(key)?.trim()
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function numbers(value: string): number[] {
  return [...value.matchAll(NUMBER)].map((match) => Number(match[0])).filter((number) => Number.isFinite(number))
}

function bytesInUnit(value: string, unit: string): number | null {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  const multiplier = unit.toUpperCase() === 'K' ? 1024
    : unit.toUpperCase() === 'M' ? 1024 ** 2
      : unit.toUpperCase() === 'G' ? 1024 ** 3
        : 1
  return amount * multiplier
}

function parseSwap(value: string | undefined): { totalBytes: number; usedBytes: number } {
  const total = /total\s*=\s*([\d.]+)\s*([KMG])/i.exec(value ?? '')
  const used = /used\s*=\s*([\d.]+)\s*([KMG])/i.exec(value ?? '')
  const totalBytes = total ? bytesInUnit(total[1], total[2]) : null
  const usedBytes = used ? bytesInUnit(used[1], used[2]) : null
  if (totalBytes === null || usedBytes === null) {
    throw new CollectorError('parse-failed', 'invalid swap')
  }
  return { totalBytes, usedBytes }
}

function parseBattery(raw: string | undefined): BatterySample | null {
  const value = raw?.trim()
  if (!value) return null
  const source = /'([^']+)'/.exec(value)?.[1] ?? null
  const percent = /(\d+)%/.exec(value)?.[1]
  const state = /;\s*([^;|]+)\s*;/.exec(value)?.[1]?.trim() ?? null
  if (percent === undefined && source === null) return null
  return {
    percent: percent === undefined ? null : Number(percent),
    state,
    source
  }
}

function processName(command: string): string {
  const token = command.trim().split(/\s+/, 1)[0] ?? ''
  const base = token.slice(token.lastIndexOf('/') + 1) || token
  const name = base.startsWith('com.') && base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base
  return name.length > 32 ? `${name.slice(0, 31)}…` : name
}

type RawProcess = {
  pid: number
  ppid: number
  cpuPercent: number
  memoryPercent: number
  command: string
}

function parseProcesses(raw: string | undefined, selfPid: number | null): ProcessSample[] {
  const entries: RawProcess[] = []
  for (const chunk of raw?.split('|') ?? []) {
    const line = chunk.trim()
    if (!line) continue
    const match = /^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const cpuPercent = Number(match[3])
    const memoryPercent = Number(match[4])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) ||
        !Number.isFinite(cpuPercent) || !Number.isFinite(memoryPercent)) continue
    entries.push({ pid, ppid, cpuPercent, memoryPercent, command: match[5] })
  }

  const parents = new Map(entries.map((entry) => [entry.pid, entry.ppid]))
  const isCollector = (pid: number): boolean => {
    if (selfPid === null) return false
    let current = pid
    for (let depth = 0; depth < 32; depth += 1) {
      if (current === selfPid) return true
      const parent = parents.get(current)
      if (parent === undefined || parent === current || parent === 0) return false
      current = parent
    }
    return false
  }

  const processes: ProcessSample[] = []
  for (const entry of entries) {
    if (isCollector(entry.pid)) continue
    const command = processName(entry.command)
    if (!command) continue
    processes.push({
      pid: entry.pid,
      command,
      cpuPercent: entry.cpuPercent,
      memoryPercent: entry.memoryPercent
    })
    if (processes.length === 5) break
  }
  return processes
}

/**
 * Parse the fixed key=value output produced by REMOTE_SCRIPT. Kept separate from SSH so
 * malformed and partial remote output can be tested without a host.
 */
export function parseRemoteMetrics(stdout: string): RemoteMetrics {
  const fields = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    fields.set(line.slice(0, index), line.slice(index + 1))
  }

  const load = numbers(requiredText(fields, 'load'))
  if (load.length < 3) throw new CollectorError('parse-failed', 'invalid load')

  const cpu = numbers(requiredText(fields, 'cpu'))
  if (cpu.length < 3) throw new CollectorError('parse-failed', 'invalid cpu')

  const vm = numbers(requiredText(fields, 'vm'))
  if (vm.length < 7 || vm[0] <= 0) throw new CollectorError('parse-failed', 'invalid vm')

  const disk = numbers(requiredText(fields, 'disk'))
  if (disk.length < 3) throw new CollectorError('parse-failed', 'invalid disk')

  const totalMemoryBytes = requiredNumber(fields, 'memsize')
  if (totalMemoryBytes <= 0) throw new CollectorError('parse-failed', 'invalid memsize')

  const net = numbers(fields.get('net') ?? '')
  const countersAvailable = net.length >= 4
  const iface = fields.get('iface')?.trim() || null
  const selfPid = optionalNumber(fields, 'self')

  return {
    model: fields.get('model')?.trim() || null,
    cores: optionalNumber(fields, 'ncpu'),
    totalMemoryBytes,
    load: [load[0], load[1], load[2]],
    cpu: {
      userPercent: cpu[0],
      sysPercent: cpu[1],
      idlePercent: cpu[2]
    },
    memory: {
      pageSize: vm[0],
      freePages: vm[1],
      activePages: vm[2],
      inactivePages: vm[3],
      speculativePages: vm[4],
      wiredPages: vm[5],
      compressedPages: vm[6]
    },
    swap: parseSwap(fields.get('swap')),
    disk: {
      totalBytes: disk[0] * 1024,
      usedBytes: disk[1] * 1024,
      availableBytes: disk[2] * 1024,
      capacityPercent: disk[3] ?? null
    },
    network: {
      interface: iface,
      rxBytes: countersAvailable ? net[1] : null,
      txBytes: countersAvailable ? net[3] : null,
      rxPackets: countersAvailable ? net[0] : null,
      txPackets: countersAvailable ? net[2] : null
    },
    bootTimeSeconds: optionalNumber(fields, 'boot'),
    uptimeSeconds: optionalNumber(fields, 'uptime'),
    batteryRaw: fields.get('battery') ?? null,
    processes: parseProcesses(fields.get('procs'), selfPid)
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function rate(current: number | null, previous: number | null, seconds: number | null): number | null {
  if (current === null || previous === null || seconds === null || seconds <= 0 || current < previous) return null
  return (current - previous) / seconds
}

/**
 * Turn one parsed remote reading into display data. Network throughput is a delta, so the
 * first sample (and any sample after a reboot or interface change) has no rate.
 */
export function buildSample(
  remote: RemoteMetrics,
  previous: NetCounters | null,
  host: string,
  at: number
): HostSample {
  const pageSize = remote.memory.pageSize
  const totalBytes = remote.totalMemoryBytes
  const usedBytes = Math.min(
    totalBytes,
    (remote.memory.activePages + remote.memory.wiredPages + remote.memory.compressedPages) * pageSize
  )
  const availableBytes = Math.min(
    totalBytes,
    (remote.memory.freePages + remote.memory.inactivePages + remote.memory.speculativePages) * pageSize
  )
  const memory: MemorySample = {
    totalBytes,
    freeBytes: remote.memory.freePages * pageSize,
    activeBytes: remote.memory.activePages * pageSize,
    inactiveBytes: remote.memory.inactivePages * pageSize,
    speculativeBytes: remote.memory.speculativePages * pageSize,
    wiredBytes: remote.memory.wiredPages * pageSize,
    compressedBytes: remote.memory.compressedPages * pageSize,
    usedBytes,
    availableBytes,
    usedPercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0,
    swapTotalBytes: remote.swap.totalBytes,
    swapUsedBytes: remote.swap.usedBytes
  }

  const bootMatches = previous !== null && previous.bootTimeSeconds !== null &&
    remote.bootTimeSeconds !== null && previous.bootTimeSeconds === remote.bootTimeSeconds
  const seconds = previous && previous.interface === remote.network.interface && bootMatches && at > previous.at
    ? (at - previous.at) / 1000
    : null
  const network: NetworkSample = {
    interface: remote.network.interface,
    rxBytes: remote.network.rxBytes,
    txBytes: remote.network.txBytes,
    rxPackets: remote.network.rxPackets,
    txPackets: remote.network.txPackets,
    rxPerSecond: rate(remote.network.rxBytes, previous?.rxBytes ?? null, seconds),
    txPerSecond: rate(remote.network.txBytes, previous?.txBytes ?? null, seconds)
  }

  const diskUsed = Math.min(remote.disk.totalBytes, remote.disk.usedBytes)
  const diskPercent = remote.disk.capacityPercent !== null
    ? remote.disk.capacityPercent
    : remote.disk.totalBytes > 0
      ? (diskUsed / remote.disk.totalBytes) * 100
      : 0
  return {
    at,
    host,
    model: remote.model,
    bootTimeSeconds: remote.bootTimeSeconds,
    cpu: {
      cores: remote.cores,
      load1: remote.load[0],
      load5: remote.load[1],
      load15: remote.load[2],
      userPercent: clampPercent(remote.cpu.userPercent),
      sysPercent: clampPercent(remote.cpu.sysPercent),
      idlePercent: clampPercent(remote.cpu.idlePercent),
      usedPercent: clampPercent(100 - remote.cpu.idlePercent)
    },
    memory,
    disk: {
      totalBytes: remote.disk.totalBytes,
      usedBytes: diskUsed,
      availableBytes: remote.disk.availableBytes,
      usedPercent: clampPercent(diskPercent)
    },
    network,
    uptimeSeconds: remote.uptimeSeconds,
    battery: parseBattery(remote.batteryRaw ?? undefined),
    processes: remote.processes
  }
}
