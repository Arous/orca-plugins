import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import { errorState, readyState, staleState } from './fixtures'
import type { HostState } from './protocol'
import * as panel from './panel'

test('draws the CPU, memory, disk and network cards', async () => {
  const host = mockHost({
    requests: {
      'stats.get': readyState,
      'stats.refresh': readyState
    }
  })
  const view = await mount(panel, { host })
  try {
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('MacBook 자원'))
    assert.ok(tree.includes('메모리'))
    assert.ok(tree.includes('디스크'))
    assert.ok(tree.includes('네트워크'))
    assert.ok(tree.includes('상위 CPU 프로세스'))

    await view.press({ text: '새로고침' })
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('shows a warning while keeping the last sample', async () => {
  const host = mockHost({ requests: { 'stats.get': staleState } })
  const view = await mount(panel, { host })
  try {
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('마지막 값을 표시하는 중'))
    assert.ok(tree.includes('지연'))
  } finally {
    await view.unmount()
  }
})

test('shows the failure state when no sample exists', async () => {
  const host = mockHost({ requests: { 'stats.get': errorState } })
  const view = await mount(panel, { host })
  try {
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('조회 실패'))
    assert.ok(tree.includes('SSH 연결에 실패했습니다.'))
  } finally {
    await view.unmount()
  }
})

test('keeps a successful sample when refresh RPC fails', async () => {
  const host = mockHost({
    requests: {
      'stats.get': readyState,
      'stats.refresh': () => {
        throw hostError('action_failed', 'refresh failed')
      }
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '새로고침' })
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('CPU'))
    assert.ok(tree.includes('자원을 새로고침하지 못했습니다.'))
    assert.ok(tree.includes('지연'))
  } finally {
    await view.unmount()
  }
})

test('ignores an older response that resolves after a newer event', async () => {
  let resolveGet: ((value: HostState) => void) | undefined
  const fallback = setTimeout(() => resolveGet?.(errorState), 1000)
  const host = mockHost({
    requests: {
      'stats.get': () => new Promise<HostState>((resolve) => {
        resolveGet = resolve
      })
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.post('stats.changed', readyState)
    assert.ok(resolveGet)
    resolveGet(errorState)
    clearTimeout(fallback)
    await view.settled()
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('CPU'))
    assert.ok(!tree.includes('조회 실패'))
  } finally {
    clearTimeout(fallback)
    resolveGet?.(errorState)
    await view.unmount()
  }
})
