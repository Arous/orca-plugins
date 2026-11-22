import { assert, test } from 'orca/testing'
import { buildA2UISurfacePayload } from './a2ui'
import {
  errorConsoleState,
  fallbackConsoleState,
  quotaHiddenConsoleState,
  readyConsoleState
} from './fixtures'
import { A2UI_CATALOG_ID, A2UI_SURFACE_ID } from './protocol'

test('serializes ConsoleState into A2UI v1.0 createSurface, updateComponents, and updateDataModel', () => {
  const messages = buildA2UISurfacePayload(readyConsoleState)
  assert.equal(messages.length, 3)

  const [createMsg, componentsMsg, dataMsg] = messages
  assert.equal(createMsg.version, '1.0')
  assert.ok('createSurface' in createMsg)
  assert.equal(createMsg.createSurface.surfaceId, A2UI_SURFACE_ID)
  assert.equal(createMsg.createSurface.catalogId, A2UI_CATALOG_ID)

  assert.equal(componentsMsg.version, '1.0')
  assert.ok('updateComponents' in componentsMsg)
  assert.equal(componentsMsg.updateComponents.surfaceId, A2UI_SURFACE_ID)
  const componentIds = new Set(componentsMsg.updateComponents.components.map((c) => c.id))
  assert.ok(componentIds.has('root'))
  assert.ok(componentIds.has('pending-section'))
  assert.ok(componentIds.has('worker-section'))
  assert.ok(componentIds.has('pending-#T1'))
  assert.ok(componentIds.has('worker-ws-tcm-01'))

  assert.equal(dataMsg.version, '1.0')
  assert.ok('updateDataModel' in dataMsg)
  assert.equal(dataMsg.updateDataModel.surfaceId, A2UI_SURFACE_ID)
  assert.equal(dataMsg.updateDataModel.path, '/')
  assert.equal(dataMsg.updateDataModel.value.revision, readyConsoleState.revision)
  assert.equal(dataMsg.updateDataModel.value.pendingCount, 1)
  assert.equal(dataMsg.updateDataModel.value.activeWorkerCount, 2)
  assert.equal(dataMsg.updateDataModel.value.totalWorkspaceCount, 3)
  assert.equal(dataMsg.updateDataModel.value.deskModel, 'openai-codex/gpt-6.2-astra (medium)')
})

test('reflects fallbackActive and error states accurately in A2UI data model', () => {
  const fallbackMessages = buildA2UISurfacePayload(fallbackConsoleState)
  const fallbackData = fallbackMessages[2]
  assert.ok('updateDataModel' in fallbackData)
  assert.equal(fallbackData.updateDataModel.value.fallbackActive, true)
  assert.equal(
    fallbackData.updateDataModel.value.deskModel,
    'antigravity/claude-sonnet-5-5-medium (medium)'
  )

  const errorMessages = buildA2UISurfacePayload(errorConsoleState)
  const errorData = errorMessages[2]
  assert.ok('updateDataModel' in errorData)
  assert.equal(errorData.updateDataModel.value.status, 'error')
  assert.equal(errorData.updateDataModel.value.pendingCount, 0)
  assert.equal(errorData.updateDataModel.value.activeWorkerCount, 0)
})

test('omits quota and PAYG components when showQuotaSection is false', () => {
  const hiddenMessages = buildA2UISurfacePayload(quotaHiddenConsoleState)
  const componentsMsg = hiddenMessages[1]
  const dataMsg = hiddenMessages[2]
  assert.ok('updateComponents' in componentsMsg)
  assert.ok('updateDataModel' in dataMsg)

  const componentIds = new Set(componentsMsg.updateComponents.components.map((c) => c.id))
  assert.equal(componentIds.has('quota-section'), false)
  assert.equal(componentIds.has('quota-codex'), false)
  assert.equal(componentIds.has('payg-opengateway'), false)
  assert.equal(componentIds.has('pending-section'), true)
  assert.equal(componentIds.has('worker-section'), true)
  assert.equal(dataMsg.updateDataModel.value.showQuotaSection, false)
})
