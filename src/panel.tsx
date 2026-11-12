// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Heading,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type { UsageState } from './protocol'
import { formatUsdDetail, monthShare } from './presentation'

type Action = 'get' | 'refresh' | 'open' | 'connect'
type Notice = { tone: Tone; title: string; text: string }

const REQUEST_FAILED = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'

const stamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

const STATUS_LABEL: Record<UsageState['status'], string> = {
  loading: '연결 중',
  ready: '조회됨',
  'login-required': '로그인 필요',
  'connection-required': '계정·팀 연결 필요',
  unavailable: '집계 대기',
  error: '조회 실패'
}
const STATUS_TONE: Record<UsageState['status'], Tone> = {
  loading: 'neutral',
  ready: 'success',
  'login-required': 'warning',
  'connection-required': 'warning',
  unavailable: 'warning',
  error: 'danger'
}
const STATUS_TEXT: Record<UsageState['status'], string> = {
  loading: 'OpenGateway 연결을 확인하고 있습니다.',
  ready: '사용액 데이터를 받지 못했습니다. 새로고침하세요.',
  'login-required': 'Orca의 OpenGateway 탭에서 로그인한 뒤 새로고침하세요.',
  'connection-required': 'OpenGateway 계정과 팀을 확인한 뒤 이 계정·팀으로 연결하세요.',
  unavailable: 'OpenGateway 사용액 집계가 아직 준비되지 않았습니다.',
  error: 'OpenGateway 사용액을 불러오지 못했습니다. 새로고침하세요.'
}

const state = atom<UsageState | null>(null)
const pending = atom<Action | null>(null)
const requestError = atom<string | null>(null)
let receivedEvents = 0

async function send(action: Action, request: () => Promise<UsageState>): Promise<void> {
  if (read(pending) !== null) return
  set(requestError, null)
  set(pending, action)
  const revision = receivedEvents
  try {
    const next = await request()
    if (receivedEvents === revision) set(state, next)
  } catch {
    set(requestError, REQUEST_FAILED)
  } finally {
    set(pending, null)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('usage.changed', (next) => {
      receivedEvents += 1
      set(state, next)
      set(requestError, null)
    })
  )
  set(pending, 'get')
  const revision = receivedEvents
  plugin
    .request('usage.get', undefined, { signal: ctx.signal })
    .then(
      (next) => {
        if (!ctx.signal.aborted && receivedEvents === revision) set(state, next)
      },
      () => {
        if (!ctx.signal.aborted) set(requestError, REQUEST_FAILED)
      }
    )
    .finally(() => {
      if (!ctx.signal.aborted) set(pending, null)
    })
}

export default function Panel() {
  const current = read(state)
  const action = read(pending)
  const failure = read(requestError)
  const busy = action !== null || (current?.refreshing ?? false)
  const snapshot = current?.status === 'ready' ? current.snapshot : null
  const share = snapshot ? monthShare(snapshot) : null
  const confirmationKey = current?.confirmationKey ?? null
  const statusText = current
    ? current.message.trim() || STATUS_TEXT[current.status]
    : STATUS_TEXT.loading

  const notice: Notice | null =
    failure && !busy
      ? { tone: 'danger', title: '요청 실패', text: failure }
      : !snapshot && !busy && current
        ? {
            tone: current.status === 'ready' ? 'warning' : STATUS_TONE[current.status],
            title: current.status === 'ready' ? '조회 결과 없음' : STATUS_LABEL[current.status],
            text: statusText
          }
        : !snapshot && !busy
          ? { tone: 'danger', title: '연결 실패', text: STATUS_TEXT.error }
          : null

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        <Heading level={1}>OpenGateway Usage</Heading>
        {busy ? (
          <Spinner label="조회 중" />
        ) : snapshot ? (
          <Badge tone="success">{STATUS_LABEL.ready}</Badge>
        ) : null}
      </Row>

      {snapshot ? (
        <Stack gap="sm">
          <Stack gap="none">
            <Text muted size="xs">
              현재 잔액 (USD)
            </Text>
            <Heading level={2}>{formatUsdDetail(snapshot.balanceUsd)}</Heading>
          </Stack>
          <Separator />
          <Row justify="between" gap="sm">
            <Stack gap="none">
              <Text size="sm">오늘 사용액</Text>
              <Text muted size="xs">
                {snapshot.periodDay.trim() || '—'} (KST)
              </Text>
            </Stack>
            <Text weight="semibold">{formatUsdDetail(snapshot.todayUsd)}</Text>
          </Row>
          <Row justify="between" gap="sm">
            <Stack gap="none">
              <Text size="sm">이번 달 사용액</Text>
              <Text muted size="xs">
                {snapshot.periodMonth.trim() || '—'} (KST)
              </Text>
            </Stack>
            <Text weight="semibold">{formatUsdDetail(snapshot.monthUsd)}</Text>
          </Row>
          <Stack gap="none">
            <Row justify="between" gap="sm">
              <Text size="sm">이번 달 사용 비중</Text>
              <Text weight="semibold">{share ? share.percent : '—'}</Text>
            </Row>
            <Text muted size="xs">
              {share
                ? `[${share.gauge}] 사용액 ÷ (사용액 + 잔액)`
                : '사용액 ÷ (사용액 + 잔액) 기준으로 계산할 수 없습니다.'}
            </Text>
          </Stack>
          <Text muted size="xs">
            업데이트 {Number.isFinite(snapshot.updatedAt) ? `${stamp.format(new Date(snapshot.updatedAt))} KST` : '—'}
          </Text>
        </Stack>
      ) : null}

      {busy && !snapshot ? (
        <Text muted size="sm">
          {action === 'connect'
            ? '이 계정·팀으로 연결하고 사용액을 조회하고 있습니다.'
            : action === 'open'
              ? 'OpenGateway 화면을 여는 중입니다.'
              : statusText}
        </Text>
      ) : null}

      {notice ? (
        <Callout tone={notice.tone} title={notice.title}>
          <Stack gap="sm">
            <Text size="sm">{notice.text}</Text>
            {current?.canConnect && confirmationKey !== null ? (
              <Button
                variant="outline"
                icon="link"
                disabled={busy}
                onPress={() => {
                  void send('connect', () =>
                    plugin.request('usage.connect', { identityKey: confirmationKey })
                  )
                }}
              >
                이 계정·팀으로 연결
              </Button>
            ) : null}
          </Stack>
        </Callout>
      ) : null}

      <Row gap="xs" wrap>
        <Button
          icon="refresh"
          disabled={busy}
          onPress={() => {
            void send('refresh', () => plugin.request('usage.refresh'))
          }}
        >
          새로고침
        </Button>
        <Button
          variant="ghost"
          icon="globe"
          disabled={busy}
          onPress={() => {
            void send('open', () => plugin.request('usage.open'))
          }}
        >
          OpenGateway 로그인/열기
        </Button>
      </Row>

      <Separator />
      <Text muted size="xs">
        5분 자동 갱신 · Asia/Seoul 기준 · 비공식 콘솔 연동
      </Text>
      <Text muted size="xs">
        로그인 세션과 토큰은 Orca 브라우저 안에만 유지합니다. 연결 대상은 계정·팀의 해시 지문으로 확인합니다.
      </Text>
    </Stack>
  )
}
