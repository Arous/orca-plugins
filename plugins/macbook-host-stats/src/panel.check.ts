import { defineCheck } from 'orca/testing'
import { errorState, readyState, staleState } from './fixtures'

export default defineCheck({
  ready: { requests: { 'stats.get': readyState } },
  stale: { requests: { 'stats.get': staleState } },
  error: { requests: { 'stats.get': errorState } }
})
