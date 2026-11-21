import { assert, test } from 'orca/testing'
import { buildSample, parseRemoteMetrics } from './collector'
import { CollectorError } from './errors'

const FIXTURE = `model=MacBookPro11,4
ncpu=8
memsize=17179869184
load= 1.76 1.53 1.47
cpu=7.20 5.00 87.80
vm=4096 89132 1572800 1572800 12530 642900 335968
swap=total = 1024.00M  used = 113.00M  free = 911.00M  (encrypted)
disk=244912536 88944820 124660760 42%
iface=en0
net=38160985 44218055775 15295486 5962071256
boot=1793814305
uptime=1461600
battery=Now drawing from 'AC Power'|-InternalBattery-0 (id=6684771)\t100%; charged; 0:00 remaining present: true
self=100
procs=1234 1 12.4 3.2 WindowServer|5678 1 8.1 6.7 Safari|9012 1 4.3 1.1 kernel_task|
`

test('parses one remote reading into bytes and percentages', () => {
  const remote = parseRemoteMetrics(FIXTURE)
  const sample = buildSample(remote, null, 'macbook2015', 1_000_000)

  assert.equal(sample.model, 'MacBookPro11,4')
  assert.equal(sample.cpu.cores, 8)
  assert.ok(Math.abs(sample.cpu.usedPercent - 12.2) < 0.01)
  assert.equal(sample.memory.totalBytes, 17_179_869_184)
  assert.ok(Math.abs(sample.memory.usedPercent - 60.84) < 0.01)
  assert.equal(sample.disk.usedPercent, 42)
  assert.equal(sample.network.interface, 'en0')
  assert.equal(sample.bootTimeSeconds, 1_793_814_305)
  assert.equal(sample.uptimeSeconds, 1_461_600)
  assert.deepEqual(sample.battery, { percent: 100, state: 'charged', source: 'AC Power' })
  assert.equal(sample.processes.length, 3)
  assert.equal(sample.processes[0].command, 'WindowServer')
})

test('computes network throughput from consecutive counters', () => {
  const firstRemote = parseRemoteMetrics(FIXTURE)
  const first = buildSample(firstRemote, null, 'macbook2015', 1_000_000)
  assert.equal(first.network.rxPerSecond, null)

  const firstRx = firstRemote.network.rxBytes ?? 0
  const nextRemote = {
    ...firstRemote,
    network: { ...firstRemote.network, rxBytes: firstRx + 1_200_000 }
  }
  const next = buildSample(nextRemote, {
    at: first.at,
    bootTimeSeconds: first.bootTimeSeconds,
    interface: first.network.interface,
    rxBytes: firstRx,
    txBytes: first.network.txBytes
  }, 'macbook2015', 1_010_000)

  assert.equal(next.network.rxPerSecond, 120_000)
})

test('drops the rate after a counter reset or interface change', () => {
  const remote = parseRemoteMetrics(FIXTURE)
  const previous = {
    at: 1_000_000,
    bootTimeSeconds: remote.bootTimeSeconds,
    interface: 'en0',
    rxBytes: (remote.network.rxBytes ?? 0) + 1,
    txBytes: remote.network.txBytes
  }

  const reset = buildSample(remote, previous, 'macbook2015', 1_010_000)
  assert.equal(reset.network.rxPerSecond, null)

  const changed = buildSample(remote, { ...previous, interface: 'utun0', rxBytes: 0 }, 'macbook2015', 1_010_000)
  assert.equal(changed.network.rxPerSecond, null)
})

test('drops the rate after the boot marker changes', () => {
  const remote = parseRemoteMetrics(FIXTURE)
  const previous = {
    at: 1_000_000,
    bootTimeSeconds: (remote.bootTimeSeconds ?? 0) - 1,
    interface: 'en0',
    rxBytes: (remote.network.rxBytes ?? 0) - 1000,
    txBytes: (remote.network.txBytes ?? 0) - 1000
  }
  const next = buildSample(remote, previous, 'macbook2015', 1_010_000)
  assert.equal(next.network.rxPerSecond, null)

  const unknownBoot = buildSample(remote, { ...previous, bootTimeSeconds: null }, 'macbook2015', 1_010_000)
  assert.equal(unknownBoot.network.rxPerSecond, null)
})

test('keeps ordinary high-CPU helpers and never exposes process arguments', () => {
  const remote = parseRemoteMetrics(FIXTURE.replace(
    /^procs=.*$/m,
    'procs=1 1 1.0 2.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer|2 1 2.0 1.0 /Applications/Foo.app/Contents/MacOS/Foo -p secret|3 1 3.0 1.0 sort|4 100 4.0 0.5 ps|5 4 5.0 0.5 sed|'
  ))
  assert.deepEqual(remote.processes.map((process) => process.command), ['Google', 'Foo', 'sort'])
  assert.ok(!remote.processes.some((process) => process.command.includes('secret')))
})

test('marks missing network counters as unavailable, not zero', () => {
  const remote = parseRemoteMetrics(FIXTURE.replace(/^net=.*$/m, 'net='))
  assert.equal(remote.network.rxBytes, null)
  const sample = buildSample(remote, null, 'macbook2015', 1_000_000)
  assert.equal(sample.network.rxBytes, null)
  assert.equal(sample.network.rxPerSecond, null)
})

test('rejects a remote reading without the required VM fields', () => {
  const broken = FIXTURE.replace(/^vm=.*$/m, '')
  assert.throws(
    () => parseRemoteMetrics(broken),
    (error: unknown) => error instanceof CollectorError && error.code === 'parse-failed'
  )
})
