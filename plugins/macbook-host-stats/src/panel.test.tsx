import { assert, mockHost, mount, test } from 'orca/testing'
import { errorState, readyState, staleState } from './fixtures'
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
