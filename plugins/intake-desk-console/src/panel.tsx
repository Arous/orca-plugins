import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  EmptyState,
  Heading,
  KeyValue,
  Progress,
  RelativeTime,
  Row,
  Select,
  Spinner,
  Stack,
  Text,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import { buildA2UISurfacePayload } from './a2ui'
import {
  consoleStatusLabel,
  consoleStatusTone,
  formatPaygSummary,
  formatQuotaMeta,
  formatQuotaSummary,
  formatTaskCost,
  isDeskOrActiveWorker,
  quotaDisplayPct,
  quotaStatusLabel,
  quotaTone,
  workerStatusLabel,
  workerStatusTone
} from './format'
import type { A2UIMessage, ConsoleState, WorkerItem } from './protocol'

const state = atom<ConsoleState | null>(null)
const failure = atom<string | null>(null)
const busy = atom(false)
const domainFilter = atom<string>('전체')
const workerScope = atom<'desk' | 'all'>('desk')
const showA2ui = atom(false)
const a2uiSnapshot = atom<A2UIMessage[] | null>(null)
let eventRevision = 0

function apply(next: ConsoleState, requestEventRevision?: number): void {
  const current = read(state)
  if (
    current &&
    next.instanceId !== current.instanceId &&
    requestEventRevision !== undefined &&
    eventRevision !== requestEventRevision
  ) {
    return
  }
  if (current && next.instanceId === current.instanceId && next.revision < current.revision) return
  set(state, next)
  set(failure, null)
  if (read(showA2ui)) {
    set(a2uiSnapshot, buildA2UISurfacePayload(next))
  }
}

export function setup(ctx: PanelContext): void {
  eventRevision = 0
  ctx.subscriptions.push(
    plugin.on('console.changed', (next) => {
      eventRevision += 1
      apply(next)
    })
  )
  const requestRevision = eventRevision
  void plugin
    .request('console.get')
    .then((next) => {
      if (!ctx.signal.aborted && eventRevision === requestRevision) apply(next)
    })
    .catch(() => {
      if (!ctx.signal.aborted && eventRevision === requestRevision && !read(state)) {
        set(failure, '플러그인 워커에 연결하지 못했습니다.')
      }
    })
}

async function runAction<T>(fn: () => Promise<ConsoleState>, errorMessage: string): Promise<void> {
  if (read(busy)) return
  const before = read(state)
  const beforeRevision = before?.revision ?? 0
  const requestInstance = before?.instanceId
  const requestEventRevision = eventRevision
  set(busy, true)
  try {
    apply(await fn(), requestEventRevision)
  } catch {
    const current = read(state)
    const superseded =
      current?.instanceId !== undefined &&
      current.instanceId !== requestInstance &&
      (requestInstance !== undefined || eventRevision !== requestEventRevision)
    if (superseded) return
    const newerCompleted =
      current !== null &&
      current.refreshing === false &&
      (current.instanceId !== requestInstance || current.revision > beforeRevision)
    if (!newerCompleted) set(failure, errorMessage)
  } finally {
    set(busy, false)
  }
}

async function refresh(): Promise<void> {
  await runAction(() => plugin.request('console.refresh'), 'Intake Desk 상태를 새로고침하지 못했습니다.')
}

async function toggleA2ui(): Promise<void> {
  const nextOpen = !read(showA2ui)
  set(showA2ui, nextOpen)
  if (!nextOpen) return
  try {
    const snapshot = await plugin.request('console.a2uiSnapshot')
    set(a2uiSnapshot, snapshot)
  } catch {
    const current = read(state)
    if (current) set(a2uiSnapshot, buildA2UISurfacePayload(current))
  }
}

function groupWorkers(workers: WorkerItem[], activeDomain: string): Array<[string, WorkerItem[]]> {
  const filtered =
    activeDomain === '전체' ? workers : workers.filter((worker) => worker.domain === activeDomain)
  const groups = new Map<string, WorkerItem[]>()
  for (const worker of filtered) {
    const list = groups.get(worker.domain) ?? []
    list.push(worker)
    groups.set(worker.domain, list)
  }
  return Array.from(groups.entries())
}

export default function Panel() {
  const current = read(state)
  const failureMessage = read(failure)
  const loading = read(busy)
  const activeDomain = read(domainFilter)
  const a2uiOpen = read(showA2ui)
  const a2uiMessages = read(a2uiSnapshot)

  if (!current) {
    return (
      <Stack gap="md">
        {failureMessage ? (
          <Callout tone="danger" title="조회 실패">
            {failureMessage}
          </Callout>
        ) : (
          <Stack gap="sm" align="center">
            <Spinner label="Intake Desk 상태 확인 중" />
            <Text muted size="sm">
              구독 Quota와 병렬 워커 상태를 불러오는 중입니다.
            </Text>
          </Stack>
        )}
        <Button size="sm" variant="outline" icon="refresh" disabled={loading} onPress={refresh}>
          {loading ? '조회 중' : '다시 시도'}
        </Button>
      </Stack>
    )
  }

  const advisor = current.advisor
  const displayStatus = failureMessage ? (advisor ? 'stale' : 'error') : current.status
  const activeScope = read(workerScope)
  const deskWorkers = current.workers.filter(isDeskOrActiveWorker)
  const scopedWorkers = activeScope === 'desk' ? deskWorkers : current.workers
  const scopedDomains = ['전체', ...Array.from(new Set(scopedWorkers.map((worker) => worker.domain)))]
  const effectiveDomain = scopedDomains.includes(activeDomain) ? activeDomain : '전체'
  const groupedWorkers = groupWorkers(scopedWorkers, effectiveDomain)
  const a2uiText = JSON.stringify(a2uiMessages ?? buildA2UISurfacePayload(current), null, 2)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>Intake Desk</Heading>
          <Badge tone={consoleStatusTone(displayStatus)}>{consoleStatusLabel(displayStatus)}</Badge>
        </Row>
        <Row gap="xs" align="center">
          <Button
            size="xs"
            variant={a2uiOpen ? 'solid' : 'outline'}
            icon="code"
            onPress={toggleA2ui}
          >
            A2UI JSON
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon="refresh"
            disabled={loading}
            onPress={refresh}
          >
            {loading ? '조회 중' : '새로고침'}
          </Button>
        </Row>
      </Row>

      <Row justify="between" align="center" gap="sm" wrap>
        <Row gap="xs" align="center" wrap>
          <Code>{advisor ? `${advisor.deskModel.active} (${advisor.deskModel.effort})` : '모델 미연결'}</Code>
          {advisor?.deskModel.fallbackActive ? <Badge tone="warning">폴백</Badge> : null}
        </Row>
        {current.lastSuccessAt ? (
          <Text muted size="xs">
            수집 <RelativeTime at={current.lastSuccessAt} format="short" />
          </Text>
        ) : null}
      </Row>

      {failureMessage || current.error ? (
        <Callout
          tone={displayStatus === 'stale' ? 'warning' : 'danger'}
          title={displayStatus === 'stale' ? '마지막 값을 표시하는 중' : '조회 실패'}
        >
          {failureMessage ?? current.error}
        </Callout>
      ) : null}

      {a2uiOpen ? (
        <Card title="A2UI v1.0">
          <Stack gap="sm">
            <CodeView
              label="A2UI v1.0 페이로드"
              language="json"
              code={a2uiText}
              maxHeight="md"
              wrap
            />
            <Row justify="end">
              <Button size="xs" variant="outline" onPress={() => set(showA2ui, false)}>
                닫기
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : null}

      <Card title="구독 Quota · 종량제">
        {advisor ? (
          <Stack gap="sm">
            {advisor.unmappedActiveProviders.length > 0 ? (
              <Callout tone="accent" title="신규 활성 구독 감지">
                {`${advisor.unmappedActiveProviders.join(', ')} 프로바이더가 활성화되어 있습니다. routing-catalog.json에 매핑을 추가할 수 있습니다.`}
              </Callout>
            ) : null}

            {advisor.quotas.map((quota) => (
              <Stack key={quota.id} gap="xs">
                <Progress
                  label={`${quota.label} · ${formatQuotaSummary(quota)}`}
                  value={quotaDisplayPct(quota)}
                />
                <Row justify="between" align="center">
                  <Badge tone={quotaTone(quota)}>
                    {quota.status === 'ok' ? `${quotaDisplayPct(quota)}%` : quotaStatusLabel(quota.status)}
                  </Badge>
                  <Text muted size="xs">
                    {formatQuotaMeta(quota)}
                  </Text>
                </Row>
              </Stack>
            ))}

            {Object.keys(advisor.payg).length > 0 ? (
              <KeyValue
                items={Object.values(advisor.payg).map((entry) => ({
                  label: entry.label,
                  value: formatPaygSummary(entry)
                }))}
              />
            ) : null}

            {advisor.recommendation ? (
              <KeyValue
                items={[
                  {
                    label: '기본 추천',
                    value: `${advisor.recommendation.agent} / ${advisor.recommendation.model} (${advisor.recommendation.effort}) · ${advisor.recommendation.track === 'track3' ? 'Track 3' : 'Track 2'} · ${formatTaskCost(advisor.recommendation.billingType, advisor.recommendation.estimatedCostUsd)}`
                  }
                ]}
              />
            ) : null}
          </Stack>
        ) : (
          <EmptyState title="Quota 정보 없음" description="route-advisor.mjs 응답을 기다리는 중입니다." icon="gauge" />
        )}
      </Card>

      <Stack gap="sm">
        <Row justify="between" align="center">
          <Heading level={3}>승인 대기 큐</Heading>
          <Badge tone={current.pending.length > 0 ? 'warning' : 'neutral'}>
            {`${current.pending.length}건`}
          </Badge>
        </Row>

        {current.pending.length === 0 ? (
          <EmptyState title="대기 중인 승인이 없습니다" icon="check" />
        ) : (
          current.pending.map((task) => (
            <Card key={task.taskId} title={`${task.taskId} · ${task.domain}`} description={task.title}>
              <Stack gap="sm">
                <Row gap="xs" wrap align="center">
                  <Badge tone="accent">{task.track === 'track3' ? 'Track 3' : 'Track 2'}</Badge>
                  <Badge tone="neutral">
                    {task.worktreeMode === 'existing' ? `기존 · ${task.worktreeName}` : task.worktreeName}
                  </Badge>
                  <Badge tone="neutral">{formatTaskCost(task.billingType, task.estimatedCostUsd)}</Badge>
                  <Text muted size="xs">{`예상 ${task.estimatedMinutes}분`}</Text>
                </Row>

                {task.reason ? (
                  <Text muted size="xs">
                    {task.reason}
                  </Text>
                ) : null}

                <Select
                  label={`${task.taskId} 모델`}
                  labelHidden
                  value={task.selectedModelId}
                  options={task.options.map((opt) => ({
                    value: opt.modelId,
                    label: opt.label
                  }))}
                  disabled={loading}
                  onChange={(value) => {
                    void runAction(
                      () =>
                        plugin.request('console.overrideModel', {
                          taskId: task.taskId,
                          modelId: value
                        }),
                      '모델 변경에 실패했습니다.'
                    )
                  }}
                />

                <Row gap="xs" wrap>
                  <Button
                    size="xs"
                    variant="solid"
                    tone="accent"
                    disabled={loading}
                    onPress={() =>
                      runAction(
                        () =>
                          plugin.request('console.approve', {
                            taskId: task.taskId,
                            modelId: task.selectedModelId
                          }),
                        '작업 승인에 실패했습니다.'
                      )
                    }
                  >
                    승인
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={loading}
                    onPress={() =>
                      runAction(
                        () =>
                          plugin.request('console.handoff', {
                            taskId: task.taskId,
                            modelId: task.selectedModelId
                          }),
                        '직접 열기에 실패했습니다.'
                      )
                    }
                  >
                    직접 열기
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    tone="danger"
                    disabled={loading}
                    onPress={() =>
                      runAction(
                        () => plugin.request('console.cancel', { taskId: task.taskId }),
                        '작업 취소에 실패했습니다.'
                      )
                    }
                  >
                    취소
                  </Button>
                </Row>
              </Stack>
            </Card>
          ))
        )}
      </Stack>

      <Stack gap="sm">
        <Row justify="between" align="center">
          <Heading level={3}>도메인 병렬 워커</Heading>
          <Badge tone={scopedWorkers.length > 0 ? 'accent' : 'neutral'}>{`${scopedWorkers.length}건`}</Badge>
        </Row>

        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant={activeScope === 'desk' ? 'solid' : 'outline'}
            onPress={() => set(workerScope, 'desk')}
          >
            {`Desk · 활성 (${deskWorkers.length})`}
          </Button>
          <Button
            size="xs"
            variant={activeScope === 'all' ? 'solid' : 'outline'}
            onPress={() => set(workerScope, 'all')}
          >
            {`전체 워크트리 (${current.workers.length})`}
          </Button>
        </Row>

        <Row gap="xs" wrap>
          {scopedDomains.map((domain) => (
            <Button
              key={domain}
              size="xs"
              variant={effectiveDomain === domain ? 'solid' : 'outline'}
              onPress={() => set(domainFilter, domain)}
            >
              {domain}
            </Button>
          ))}
        </Row>

        {groupedWorkers.length === 0 ? (
          <EmptyState
            title={
              activeScope === 'desk'
                ? '실행 중인 Desk 워커가 없습니다'
                : '워크트리가 없습니다'
            }
            icon="bot"
          />
        ) : (
          groupedWorkers.map(([domain, workers]) => (
            <Card key={domain} title={`${domain} (${workers.length})`}>
              <Stack gap="sm">
                {workers.map((worker) => (
                  <Box key={worker.id} padding="sm" border radius="sm" gap="xs">
                    <Row justify="between" align="center" gap="xs">
                      <Text weight="medium" size="sm" truncate>
                        {worker.name}
                      </Text>
                      <Badge tone={workerStatusTone(worker.status)}>
                        {workerStatusLabel(worker.status)}
                      </Badge>
                    </Row>
                    <Row gap="xs" wrap align="center">
                      <Text muted size="xs">
                        {worker.track}
                      </Text>
                      {worker.modelLabel ? <Code>{worker.modelLabel}</Code> : null}
                    </Row>
                    {worker.workspaceId ? (
                      <Row gap="xs">
                        <Button
                          size="xs"
                          variant="outline"
                          icon="open-external"
                          disabled={loading}
                          onPress={() =>
                            runAction(
                              () =>
                                plugin.request('console.openWorkspace', {
                                  workspaceId: worker.workspaceId!
                                }),
                              '워크스페이스를 열지 못했습니다.'
                            )
                          }
                        >
                          채팅 열기
                        </Button>
                      </Row>
                    ) : null}
                  </Box>
                ))}
              </Stack>
            </Card>
          ))
        )}
      </Stack>
    </Stack>
  )
}
