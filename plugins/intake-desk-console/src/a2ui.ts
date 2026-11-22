import {
  formatPaygSummary,
  formatQuotaSummary,
  isDeskOrActiveWorker,
  workerStatusLabel
} from './format'
import {
  A2UI_CATALOG_ID,
  A2UI_SURFACE_ID,
  type A2UIComponent,
  type A2UIMessage,
  type ConsoleState
} from './protocol'

/**
 * Pure serializer converting ConsoleState into an A2UI v1.0 message sequence:
 * createSurface -> updateComponents -> updateDataModel.
 */
export function buildA2UISurfacePayload(state: ConsoleState): A2UIMessage[] {
  const components: A2UIComponent[] = []
  const quotaIds: string[] = []
  const pendingIds: string[] = []
  const workerIds: string[] = []

  const showQuotaSection = state.showQuotaSection !== false
  const quotas = state.advisor?.quotas ?? []
  const paygEntries = Object.entries(state.advisor?.payg ?? {})

  if (showQuotaSection) {
    for (const quota of quotas) {
      const id = `quota-${quota.id}`
      quotaIds.push(id)
      components.push({
        id,
        component: {
          Card: {
            title: quota.label,
            subtitle: formatQuotaSummary(quota),
            meta: quota.resetLabel ?? ''
          }
        }
      })
    }

    for (const [key, entry] of paygEntries) {
      const id = `payg-${key}`
      quotaIds.push(id)
      components.push({
        id,
        component: {
          Card: {
            title: entry.label,
            subtitle: formatPaygSummary(entry),
            meta: entry.estimateKind
          }
        }
      })
    }
  }

  const taskIdCounts = new Map<string, number>()
  for (const task of state.pending) {
    taskIdCounts.set(task.taskId, (taskIdCounts.get(task.taskId) ?? 0) + 1)
  }

  for (const task of state.pending) {
    const id =
      (taskIdCounts.get(task.taskId) ?? 0) > 1
        ? `pending-${task.taskId}-${task.createdAt}`
        : `pending-${task.taskId}`
    pendingIds.push(id)
    components.push({
      id,
      component: {
        Card: {
          title: `${task.taskId} · ${task.title}`,
          subtitle: `${task.domain} · ${task.selectedModelId}`,
          actions: [
            {
              label: '승인',
              action: { name: 'approveTask', context: { taskId: task.taskId, createdAt: task.createdAt } }
            },
            {
              label: '직접 열기',
              action: { name: 'handoffTask', context: { taskId: task.taskId, createdAt: task.createdAt } }
            },
            {
              label: '취소',
              action: { name: 'cancelTask', context: { taskId: task.taskId, createdAt: task.createdAt } }
            }
          ]
        }
      }
    })
  }

  for (const worker of state.workers) {
    const id = `worker-${worker.id}`
    workerIds.push(id)
    components.push({
      id,
      component: {
        Card: {
          title: worker.name,
          subtitle: `${worker.domain} · ${workerStatusLabel(worker.status)}`,
          actions: worker.workspaceId
            ? [
                {
                  label: '채팅 열기',
                  action: { name: 'openWorkspace', context: { workspaceId: worker.workspaceId } }
                }
              ]
            : []
        }
      }
    })
  }

  components.unshift(
    {
      id: 'root',
      component: {
        Column: {
          children: {
            explicitList: showQuotaSection
              ? ['header', 'quota-section', 'pending-section', 'worker-section']
              : ['header', 'pending-section', 'worker-section']
          }
        }
      }
    },
    {
      id: 'header',
      component: {
        Row: {
          children: { explicitList: ['header-title', 'header-refresh'] }
        }
      }
    },
    {
      id: 'header-title',
      component: {
        Text: {
          text: { path: '/deskModel' },
          usageHint: 'h3'
        }
      }
    },
    {
      id: 'header-refresh',
      component: {
        Button: {
          label: '새로고침',
          action: { name: 'refreshConsole' }
        }
      }
    },
    ...(showQuotaSection
      ? [
          {
            id: 'quota-section',
            component: {
              Column: {
                children: { explicitList: quotaIds }
              }
            }
          }
        ]
      : []),
    {
      id: 'pending-section',
      component: {
        Column: {
          children: { explicitList: pendingIds }
        }
      }
    },
    {
      id: 'worker-section',
      component: {
        Column: {
          children: { explicitList: workerIds }
        }
      }
    }
  )

  const deskModel = state.advisor
    ? `${state.advisor.deskModel.active} (${state.advisor.deskModel.effort})`
    : '미연결'

  const activeWorkerCount = state.workers.filter(isDeskOrActiveWorker).length
  const rec = state.advisor?.recommendation

  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: A2UI_SURFACE_ID,
        catalogId: A2UI_CATALOG_ID
      }
    },
    {
      version: '1.0',
      updateComponents: {
        surfaceId: A2UI_SURFACE_ID,
        components
      }
    },
    {
      version: '1.0',
      updateDataModel: {
        surfaceId: A2UI_SURFACE_ID,
        path: '/',
        value: {
          revision: state.revision,
          status: state.status,
          showQuotaSection,
          deskModel,
          fallbackActive: state.advisor?.deskModel.fallbackActive ?? false,
          quotas: quotas.map((q) => ({
            id: q.id,
            label: q.label,
            status: q.status,
            sessionUsedPct: q.sessionUsedPct,
            weeklyUsedPct: q.weeklyUsedPct,
            monthlyUsedPct: q.monthlyUsedPct,
            paceRatio: q.paceRatio,
            resetLabel: q.resetLabel,
            burnDownBonus: q.burnDownBonus
          })),
          payg: paygEntries.map(([, entry]) => ({
            provider: entry.provider,
            label: entry.label,
            last24hUsd: entry.last24hUsd,
            last7dUsd: entry.last7dUsd
          })),
          unmappedActiveProviders: state.advisor?.unmappedActiveProviders ?? [],
          defaultRecommendation: rec
            ? {
                agent: rec.agent,
                model: rec.model,
                effort: rec.effort,
                track: rec.track,
                billingType: rec.billingType,
                domain: rec.domain,
                worktree: rec.worktree
              }
            : null,
          pendingCount: state.pending.length,
          activeWorkerCount,
          totalWorkspaceCount: state.workers.length,
          pending: state.pending.map((p) => ({
            taskId: p.taskId,
            createdAt: p.createdAt,
            domain: p.domain,
            track: p.track,
            worktreeMode: p.worktreeMode,
            modelId: p.selectedModelId,
            title: p.title
          })),
          workers: state.workers.map((w) => ({
            id: w.id,
            taskId: w.taskId,
            workspaceId: w.workspaceId,
            domain: w.domain,
            name: w.name,
            status: w.status,
            isDeskOwned: w.isDeskOwned,
            isActive: w.isActive
          })),
          error: state.error
        }
      }
    }
  ]
}
