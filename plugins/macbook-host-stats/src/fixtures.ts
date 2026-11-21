import type { HostSample, HostState } from './protocol'

const GiB = 1024 ** 3

export const remoteMetrics = {
  model: 'MacBookPro11,4',
  cores: 8,
  totalMemoryBytes: 16 * GiB,
  load: [1.76, 1.53, 1.47] as [number, number, number],
  cpu: { userPercent: 7.2, sysPercent: 5, idlePercent: 87.8 },
  memory: {
    pageSize: 4096,
    freePages: 1000,
    activePages: 200_000,
    inactivePages: 100_000,
    speculativePages: 1000,
    wiredPages: 50_000,
    compressedPages: 10_000
  },
  swap: { totalBytes: 1 * GiB, usedBytes: 113 * 1024 ** 2 },
  disk: {
    totalBytes: 100 * GiB,
    usedBytes: 42 * GiB,
    availableBytes: 58 * GiB,
    capacityPercent: 42
  },
  network: {
    interface: 'en0',
    rxBytes: 1000,
    txBytes: 500,
    rxPackets: 10,
    txPackets: 5
  },
  bootTimeSeconds: 1_793_814_305,
  uptimeSeconds: 1_461_600,
  batteryRaw: "Now drawing from 'AC Power'|-InternalBattery-0 100%; charged; 0:00 remaining present: true",
  processes: [{ pid: 1, command: 'WindowServer', cpuPercent: 12.4, memoryPercent: 3.2 }]
}


const sample: HostSample = {
  at: 1_795_280_000_000,
  host: 'macbook2015',
  model: 'MacBookPro11,4',
  bootTimeSeconds: 1_793_814_305,
  cpu: {
    cores: 8,
    load1: 1.76,
    load5: 1.53,
    load15: 1.47,
    userPercent: 7.2,
    sysPercent: 5.0,
    idlePercent: 87.8,
    usedPercent: 12.2
  },
  memory: {
    totalBytes: 16 * GiB,
    freeBytes: 0.34 * GiB,
    activeBytes: 6.0 * GiB,
    inactiveBytes: 6.0 * GiB,
    speculativeBytes: 0.05 * GiB,
    wiredBytes: 2.45 * GiB,
    compressedBytes: 1.28 * GiB,
    usedBytes: 9.73 * GiB,
    availableBytes: 6.39 * GiB,
    usedPercent: 60.8,
    swapTotalBytes: 1 * GiB,
    swapUsedBytes: 113 * 1024 ** 2
  },
  disk: {
    totalBytes: 244_912_536 * 1024,
    usedBytes: 88_944_820 * 1024,
    availableBytes: 124_660_760 * 1024,
    usedPercent: 42
  },
  network: {
    interface: 'en0',
    rxBytes: 44_044_402_400,
    txBytes: 5_958_124_320,
    rxPackets: 38_160_985,
    txPackets: 15_295_486,
    rxPerSecond: 1.2 * 1024 ** 2,
    txPerSecond: 300 * 1024
  },
  uptimeSeconds: 1_461_600,
  battery: {
    percent: 100,
    state: 'charged',
    source: 'AC Power'
  },
  processes: [
    { pid: 1234, command: 'WindowServer', cpuPercent: 12.4, memoryPercent: 3.2 },
    { pid: 5678, command: 'Safari', cpuPercent: 8.1, memoryPercent: 6.7 },
    { pid: 9012, command: 'kernel_task', cpuPercent: 4.3, memoryPercent: 1.1 }
  ]
}

export const readyState: HostState = {
  status: 'ready',
  host: 'macbook2015',
  instanceId: 'test-worker',
  revision: 1,
  sample,
  error: null,
  lastAttemptAt: sample.at,
  lastSuccessAt: sample.at,
  refreshing: false
}

export const staleState: HostState = {
  ...readyState,
  status: 'stale',
  revision: 2,
  error: 'SSH 연결에 실패했습니다. 호스트와 키를 확인하세요.'
}

export const errorState: HostState = {
  status: 'error',
  host: 'macbook2015',
  instanceId: 'test-worker',
  revision: 3,
  sample: null,
  error: 'SSH 연결에 실패했습니다. 호스트와 키를 확인하세요.',
  lastAttemptAt: sample.at - 60_000,
  lastSuccessAt: null,
  refreshing: false
}
