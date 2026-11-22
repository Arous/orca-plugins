import { defineCheck } from 'orca/testing'
import { buildA2UISurfacePayload } from './a2ui'
import {
  errorConsoleState,
  fallbackConsoleState,
  readyConsoleState,
  unavailableQuotaConsoleState
} from './fixtures'

export default defineCheck({
  ready: {
    requests: {
      'console.get': readyConsoleState,
      'console.a2uiSnapshot': buildA2UISurfacePayload(readyConsoleState)
    }
  },
  fallback: {
    requests: {
      'console.get': fallbackConsoleState,
      'console.a2uiSnapshot': buildA2UISurfacePayload(fallbackConsoleState)
    }
  },
  unavailable: {
    requests: {
      'console.get': unavailableQuotaConsoleState,
      'console.a2uiSnapshot': buildA2UISurfacePayload(unavailableQuotaConsoleState)
    }
  },
  error: {
    requests: {
      'console.get': errorConsoleState,
      'console.a2uiSnapshot': buildA2UISurfacePayload(errorConsoleState)
    }
  }
})
