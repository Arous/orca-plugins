import { assert, test } from 'orca/testing'
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  statusBarText,
  statusBarTooltip,
  statusTone
} from './format'
import { readyState } from './fixtures'

test('formats bytes, rates and durations for a narrow panel', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GiB')
  assert.equal(formatRate(null), '—')
  assert.equal(formatRate(120_000), '117.2 KiB/s')
  assert.equal(formatPercent(12.24), '12.2%')
  assert.equal(formatDuration(1_461_600), '16d 22h')
  assert.equal(formatDuration(3_600), '1h 0m')
})

test('builds a compact status bar entry from the last sample', () => {
  assert.equal(statusBarText(readyState), 'MBP 12% · 61% · 42%')
  assert.equal(statusTone(readyState.status), 'success')
  const tooltip = statusBarTooltip(readyState)
  assert.ok(tooltip.includes('macbook2015 · MacBookPro11,4'))
  assert.ok(tooltip.includes('CPU 12.2%'))
  assert.ok(tooltip.includes('마지막 수집'))
})
