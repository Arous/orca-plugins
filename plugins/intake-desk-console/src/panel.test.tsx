import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import { buildA2UISurfacePayload } from './a2ui'
import {
  errorConsoleState,
  expiringConsoleState,
  fallbackConsoleState,
  newSubConsoleState,
  readyConsoleState,
  staleConsoleState
} from './fixtures'
import * as panel from './panel'
import type { ConsoleState } from './protocol'

const FORBIDDEN_HINTS = ['클릭', '탭하여', '이전 화면 유지', '호버', '패턴']

function assertNoHintCopy(treeJson: string, label: string): void {
  for (const forbidden of FORBIDDEN_HINTS) {
    assert.equal(
      treeJson.includes(forbidden),
      false,
      `${label}: forbidden hint copy "${forbidden}" found in rendered UI`
    )
  }
}

test('renders header, quota/PAYG strip, pending queue, and domain worker board cleanly', async () => {
  const host = mockHost({
    requests: {
      'console.get': readyConsoleState,
      'console.refresh': readyConsoleState
    }
  })
  const view = await mount(panel, { host })
  try {
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('Intake Desk'))
    assert.ok(tree.includes('openai-codex/gpt-6.2-astra'))
    assert.ok(tree.includes('Codex ProMax'))
    assert.ok(tree.includes('OpenGateway (종량제)'))
    assert.ok(tree.includes('24h $25.83'))
    assert.ok(tree.includes('#T1'))
    assert.ok(tree.includes('desk-tcm-checkin-card'))
    assert.ok(tree.includes('desk-obs-dedup'))
    assertNoHintCopy(tree, 'ready')

    await view.press({ text: '새로고침' })
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    await view.unmount()
  }
})

test('wires Select override, approve, handoff, cancel, and openWorkspace actions', async () => {
  const calls: Array<{ name: string; input: unknown }> = []
  let current: ConsoleState = structuredClone(readyConsoleState)

  const host = mockHost({
    requests: {
      'console.get': () => current,
      'console.overrideModel': (input) => {
        calls.push({ name: 'console.overrideModel', input })
        current = {
          ...current,
          revision: current.revision + 1,
          pending: current.pending.map((p) =>
            p.taskId === input.taskId ? { ...p, selectedModelId: input.modelId } : p
          )
        }
        return current
      },
      'console.approve': (input) => {
        calls.push({ name: 'console.approve', input })
        current = { ...current, revision: current.revision + 1, pending: [] }
        return current
      },
      'console.handoff': (input) => {
        calls.push({ name: 'console.handoff', input })
        return current
      },
      'console.cancel': (input) => {
        calls.push({ name: 'console.cancel', input })
        return current
      },
      'console.openWorkspace': (input) => {
        calls.push({ name: 'console.openWorkspace', input })
        return current
      }
    }
  })

  const view = await mount(panel, { host })
  try {
    const modelSelect = view.find({ type: 'Select', label: '#T1 모델' })
    assert.ok(modelSelect)
    await view.select(modelSelect, 'antigravity/claude-sonnet-5-5-high:high')
    assert.equal(calls[0]?.name, 'console.overrideModel')

    await view.press({ text: '채팅 열기' })
    assert.ok(calls.some((c) => c.name === 'console.openWorkspace'))

    await view.press({ text: '승인' })
    assert.ok(calls.some((c) => c.name === 'console.approve'))
    assert.ok(JSON.stringify(view.tree()).includes('대기 중인 승인이 없습니다'))

    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('supports domain filtering and A2UI JSON toggle view', async () => {
  const host = mockHost({
    requests: {
      'console.get': readyConsoleState,
      'console.a2uiSnapshot': () => buildA2UISurfacePayload(readyConsoleState)
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: 'ObsidianAutomation' })
    const filteredTree = JSON.stringify(view.tree())
    assert.ok(filteredTree.includes('desk-obs-dedup'))
    assert.equal(filteredTree.includes('desk-tcm-checkin-card'), false)

    await view.press({ text: '전체' })
    assert.ok(JSON.stringify(view.tree()).includes('desk-tcm-checkin-card'))

    await view.press({ text: 'A2UI JSON' })
    const a2uiTree = JSON.stringify(view.tree())
    assert.ok(a2uiTree.includes('intake_desk_console'))
    assert.ok(a2uiTree.includes('createSurface'))
    assert.ok(a2uiTree.includes('updateComponents'))
    assert.ok(a2uiTree.includes('updateDataModel'))
    assertNoHintCopy(a2uiTree, 'a2ui-json')
  } finally {
    await view.unmount()
  }
})

test('renders fallback, unmapped provider, D-3, stale, and error states without hint copy', async () => {
  for (const [label, fixture] of [
    ['fallback', fallbackConsoleState],
    ['newSub', newSubConsoleState],
    ['expiring', expiringConsoleState],
    ['stale', staleConsoleState],
    ['error', errorConsoleState]
  ] as const) {
    const host = mockHost({ requests: { 'console.get': fixture } })
    const view = await mount(panel, { host })
    try {
      const tree = JSON.stringify(view.tree())
      assertNoHintCopy(tree, label)
      if (label === 'fallback') assert.ok(tree.includes('폴백'))
      if (label === 'newSub') assert.ok(tree.includes('cursor'))
      if (label === 'expiring') assert.ok(tree.includes('Burn-down +25'))
      if (label === 'stale') assert.ok(tree.includes('지연'))
      if (label === 'error') assert.ok(tree.includes('조회 실패'))
      assert.deepEqual(view.errors, [])
      assert.deepEqual(view.warnings, [])
    } finally {
      await view.unmount()
    }
  }

  const unreachableHost = mockHost({
    requests: {
      'console.get': () => {
        throw hostError('unavailable', 'worker unavailable')
      }
    }
  })
  const view = await mount(panel, { host: unreachableHost })
  try {
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('플러그인 워커에 연결하지 못했습니다.'))
    assertNoHintCopy(tree, 'unreachable')
  } finally {
    await view.unmount()
  }
})
