import { assert, test } from 'orca/testing'
import { monthShare } from './presentation'

const shareOf = (monthUsd: number, balanceUsd: number) => monthShare({ monthUsd, balanceUsd })

test('share comes from raw amounts, not the two-decimal display pair', () => {
  const share = shareOf(0.004, 0.006)
  assert.equal(share?.percent, '40.00%')
  assert.equal(share?.gauge, '■■□□□')
})

test('two zero amounts have no share instead of a fabricated percent', () => {
  assert.equal(shareOf(0, 0), null)
})

test('negative adjustments have no share even when the balance covers them', () => {
  assert.equal(shareOf(40, -10), null)
  assert.equal(shareOf(-1, 10), null)
})

test('non-finite amounts have no share', () => {
  assert.equal(shareOf(Number.NaN, 10), null)
  assert.equal(shareOf(10, Number.POSITIVE_INFINITY), null)
})

test('an exhausted balance is a true 100 percent share', () => {
  const share = shareOf(40, 0)
  assert.equal(share?.ratio, 1)
  assert.equal(share?.gauge, '■■■■■')
  assert.equal(share?.percent, '100.00%')
})

test('almost 100 percent never draws a full gauge or claims 100 percent', () => {
  const share = shareOf(999.99, 0.01)
  assert.equal(share?.gauge, '■■■■□')
  assert.equal(share?.percent, '99.99%')
})

test('zero spend with a positive balance is an empty gauge at 0 percent', () => {
  const share = shareOf(0, 60)
  assert.equal(share?.ratio, 0)
  assert.equal(share?.gauge, '□□□□□')
  assert.equal(share?.percent, '0.00%')
})
