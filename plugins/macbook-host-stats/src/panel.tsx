import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Grid,
  Heading,
  KeyValue,
  Progress,
  RelativeTime,
  Row,
  Spinner,
  Stack,
  Table,
  Text,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import {
  batteryText,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  statusLabel,
  statusTone
} from './format'
import type { HostState } from './protocol'

const state = atom<HostState | null>(null)
const failure = atom<string | null>(null)
const busy = atom(false)

/** A slow request must not overwrite a newer worker state. */
function apply(next: HostState): void {
  const current = read(state)
  if (!current || next.instanceId !== current.instanceId || next.revision >= current.revision) {
    set(state, next)
    set(failure, null)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('stats.changed', apply))
  void plugin.request('stats.get').then((next) => {
    if (!ctx.signal.aborted) apply(next)
  }).catch(() => {
    if (!ctx.signal.aborted) set(failure, '플러그인 워커에 연결하지 못했습니다.')
  })
}

async function refresh(): Promise<void> {
  if (read(busy)) return
  set(busy, true)
  try {
    apply(await plugin.request('stats.refresh'))
  } catch {
    set(failure, '자원을 새로고침하지 못했습니다.')
  } finally {
    set(busy, false)
  }
}

export default function Panel() {
  const current = read(state)
  const failureMessage = read(failure)
  const loading = read(busy)

  if (!current) {
    return (
      <Stack gap="md">
        {failureMessage ? (
          <Callout tone="danger" title="조회 실패">{failureMessage}</Callout>
        ) : (
          <Stack gap="sm" align="center">
            <Spinner label="MacBook 자원 확인 중" />
            <Text muted size="sm">macbook2015에 연결하고 있습니다.</Text>
          </Stack>
        )}
        <Button size="sm" variant="outline" icon="refresh" disabled={loading} onPress={refresh}>
          {loading ? '조회 중' : '다시 시도'}
        </Button>
      </Stack>
    )
  }

  const sample = current.sample
  const displayStatus = failureMessage ? (sample ? 'stale' : 'error') : current.status
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>MacBook 자원</Heading>
        <Badge tone={statusTone(displayStatus)}>{statusLabel(displayStatus)}</Badge>
      </Row>

      <Row justify="between" align="center" gap="sm">
        <Stack gap="none">
          <Text size="sm" weight="medium">{current.host}</Text>
          {sample ? (
            <Text muted size="xs">
              마지막 수집 <RelativeTime at={sample.at} format="short" />
            </Text>
          ) : (
            <Text muted size="xs">수집 전</Text>
          )}
        </Stack>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          tooltip="SSH로 지금 다시 조회합니다"
          disabled={loading}
          onPress={refresh}
        >
          {loading ? '조회 중' : '새로고침'}
        </Button>
      </Row>

      {failureMessage || current.error ? (
        <Callout
          tone={displayStatus === 'stale' ? 'warning' : 'danger'}
          title={displayStatus === 'stale' ? '마지막 값을 표시하는 중' : '조회 실패'}
        >
          {failureMessage ?? current.error}
        </Callout>
      ) : null}

      {sample ? (
        <>
          <Grid columns={2} gap="sm">
            <Card title="CPU">
              <Stack gap="sm">
                <Progress label={`사용률 ${formatPercent(sample.cpu.usedPercent)}`} value={sample.cpu.usedPercent} />
                <KeyValue
                  items={[
                    { label: 'Load 1/5/15m', value: `${sample.cpu.load1.toFixed(2)} / ${sample.cpu.load5.toFixed(2)} / ${sample.cpu.load15.toFixed(2)}` },
                    { label: 'User / Sys', value: `${formatPercent(sample.cpu.userPercent)} / ${formatPercent(sample.cpu.sysPercent)}` },
                    { label: '코어', value: sample.cpu.cores ?? '—' }
                  ]}
                />
              </Stack>
            </Card>

            <Card title="메모리">
              <Stack gap="sm">
                <Progress label={`사용률 ${formatPercent(sample.memory.usedPercent)}`} value={sample.memory.usedPercent} />
                <KeyValue
                  items={[
                    { label: '사용 / 전체', value: `${formatBytes(sample.memory.usedBytes)} / ${formatBytes(sample.memory.totalBytes)}` },
                    { label: '여유', value: formatBytes(sample.memory.availableBytes) },
                    { label: 'Wired / 압축', value: `${formatBytes(sample.memory.wiredBytes)} / ${formatBytes(sample.memory.compressedBytes)}` },
                    { label: 'Swap', value: `${formatBytes(sample.memory.swapUsedBytes)} / ${formatBytes(sample.memory.swapTotalBytes)}` }
                  ]}
                />
              </Stack>
            </Card>

            <Card title="디스크">
              <Stack gap="sm">
                <Progress label={`사용률 ${formatPercent(sample.disk.usedPercent)}`} value={sample.disk.usedPercent} />
                <KeyValue
                  items={[
                    { label: '사용 / 전체', value: `${formatBytes(sample.disk.usedBytes)} / ${formatBytes(sample.disk.totalBytes)}` },
                    { label: '남음', value: formatBytes(sample.disk.availableBytes) },
                    { label: '볼륨', value: '/System/Volumes/Data', code: true }
                  ]}
                />
              </Stack>
            </Card>

            <Card title="네트워크">
              <KeyValue
                items={[
                  { label: '인터페이스', value: sample.network.interface ?? '없음', code: true },
                  { label: '다운로드', value: formatRate(sample.network.rxPerSecond) },
                  { label: '업로드', value: formatRate(sample.network.txPerSecond) },
                  { label: '누적 RX / TX', value: `${formatBytes(sample.network.rxBytes)} / ${formatBytes(sample.network.txBytes)}` }
                ]}
              />
            </Card>
          </Grid>

          <Card title="시스템">
            <KeyValue
              items={[
                { label: '모델', value: sample.model ?? '—' },
                { label: '가동 시간', value: formatDuration(sample.uptimeSeconds) },
                { label: '배터리', value: batteryText(sample) },
                { label: '수집 시각', value: new Date(sample.at).toLocaleString('ko-KR') }
              ]}
            />
          </Card>

          <Table
            label="상위 CPU 프로세스"
            columns={[
              { key: 'pid', label: 'PID', width: 'sm' },
              { key: 'command', label: '프로세스' },
              { key: 'cpu', label: 'CPU', align: 'end', width: 'sm' },
              { key: 'memory', label: 'MEM', align: 'end', width: 'sm' }
            ]}
            rows={sample.processes.map((process) => ({
              key: String(process.pid),
              cells: {
                pid: process.pid,
                command: process.command,
                cpu: formatPercent(process.cpuPercent),
                memory: formatPercent(process.memoryPercent)
              }
            }))}
            emptyText="프로세스 정보 없음"
          />
        </>
      ) : (
        <Callout tone="neutral" title="표시할 자원이 없습니다">
          새로고침을 누르면 SSH로 macbook2015를 조회합니다.
        </Callout>
      )}
    </Stack>
  )
}
