# Intake Desk Console

Orca 우측 사이드바에서 Intake Desk의 구독 Quota·종량제 추정 비용, 승인 대기 큐, 도메인별 병렬 워커 보드, 그리고 A2UI v1.0 스냅샷을 관제하는 플러그인입니다.

## 주요 기능

- **Desk 메인 모델 상태**: `route-advisor.mjs --json`이 보고하는 활성 메인 모델과 Codex 429 폴백 여부를 헤더와 하단 상태 표시줄에 표시합니다.
- **구독 Quota · 종량제 스트립**: 구독별 사용률 진행바, 리셋/페이스/Burn-down 가중치, OpenGateway 24h·7d 정가환산 추정액, 미매핑 신규 활성 구독(`unmappedActiveProviders`) 알림 및 `Quota 숨기기` / `Quota 보기` 섹션 토글을 제공합니다.
- **승인 대기 큐**: 추천 모델 `Select` 오버라이드와 원클릭 `승인`(Track 2), `직접 열기`(Track 3), `취소` 액션을 제공합니다.
- **도메인별 병렬 워커 보드**: `project.list`와 `workspace.list({ includeStatus: true })`로 도메인별 병렬 워커를 묶어 표시하고, 도메인 필터 및 `채팅 열기`(`workspace.open`) 액션을 제공합니다.
- **A2UI v1.0 스냅샷**: 헤더의 `A2UI JSON` 버튼으로 현재 `ConsoleState`를 `createSurface`, `updateComponents`, `updateDataModel` 메시지 배열로 확인할 수 있습니다.

## 설정

Settings → Plugins → Intake Desk Console에서 설정합니다.

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `advisorScriptPath` | `~/.orca/bots/intake-desk/scripts/route-advisor.mjs` | `route-advisor.mjs --json` 실행 경로 |
| `pendingQueuePath` | `~/.orca/bots/intake-desk/memory/pending-approvals.json` | 승인 대기 큐 JSON 파일 경로(플러그인은 읽기 전용, 처리 기록은 sibling `.handled.json`에 분리 저장) |
| `pollSeconds` | `30` | 상태 갱신 주기(15–300초) |
| `showQuotaSection` | `true` | 사이드바에 `구독 Quota · 종량제` 카드를 표시할지 여부(패널 상단 `Quota 숨기기`/`Quota 보기` 버튼으로도 즉시 전환 및 저장됨) |

## 권한 및 경계

- 실행 프로필: `trusted-worker`
- 선언된 capability: `workspace:read`, `workspace:write`, `agent:read`, `agent:launch`, `terminal:send`, `notifications:show`, `storage:own`, `settings:own`
- `route-advisor.mjs`가 없거나 JSON 계약 v1과 맞지 않거나 실행 시간이 초과되어도 워커는 중단되지 않고 지연(`stale`) 또는 오류(`error`) 상태로 전환되며 도메인 워커 보드는 계속 표시됩니다.

## 개발 및 검증

```sh
npm install --ignore-scripts --no-audit --no-fund
orca plugin types .
npm run typecheck
orca plugin validate . --json
orca plugin test . --json
npm run check
```
