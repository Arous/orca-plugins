# MacBook Host Stats

SSH로 `macbook2015`의 CPU, 메모리, 디스크, 네트워크 상태를 읽어 Orca 오른쪽 패널과 하단 상태 표시줄에 보여주는 플러그인입니다. Orca가 직접 원격 자원 메트릭을 제공하지 않으므로, `trusted-worker`가 Mac Studio에서 `ssh`를 실행해 macOS 명령 출력을 읽습니다.

## 표시 항목

- **CPU**: load average 1/5/15분, user/sys/idle 비율, 논리 코어 수
- **메모리**: 전체/사용/여유, wired, compressed, swap
- **디스크**: `/System/Volumes/Data` APFS 데이터 볼륨의 전체/사용/남은 공간
- **네트워크**: 기본 라우트 인터페이스, 누적 RX/TX, 두 샘플 사이의 초당 처리량
- **시스템**: 모델, 가동 시간, 배터리 상태, 수집 시각
- **프로세스**: CPU 사용률 상위 5개. 수집기 자신이 만든 `ps`/`sed`/`tr` 프로세스는 원격 셸 PID의 자손 관계로 제외하며, 이름이 같은 사용자 프로세스는 숨기지 않습니다. 실행 인자는 원격에서 잘라내 패널로 전달하지 않습니다.

배터리와 상위 프로세스는 핵심 네 가지 지표(CPU·메모리·디스크·네트워크)에 대한 추가 표시입니다. 필요하지 않으면 패널에서 해당 카드만 제거할 수 있습니다.

하단 상태 표시줄은 `MBP 12% · 61% · 42%`처럼 CPU·메모리·디스크 사용률만 요약합니다. SSH가 실패하면 마지막 값을 유지하면서 `MBP 연결 지연`으로 표시하고, 성공한 적이 없으면 `MBP 연결 안 됨`으로 표시합니다. 실패를 0%나 정상 값으로 바꾸지 않습니다.

## 요구 사항

- macOS의 Orca 1.4.248 이상, 플러그인 기능 활성화
- `~/.ssh/config`에 대상 호스트 별칭이 있고, `BatchMode=yes`로 키 인증이 가능해야 합니다. 기본값은 `macbook2015`입니다.
- 원격 호스트에 `ssh`, `sysctl`, `vm_stat`, `iostat`, `df`, `netstat`, `route`, `pmset`, `ps`가 있어야 합니다. macOS 기본 설치에 포함된 명령만 사용합니다.
- root 권한은 필요하지 않습니다. CPU 온도, 팬 RPM, GPU 사용률은 `powermetrics`가 root를 요구하므로 표시하지 않습니다.

## 설치

이 저장소의 `orca-catalog.json`에 등록된 하위 폴더 플러그인입니다.

카탈로그를 추가한 뒤 설치:

```sh
orca plugin catalog add Arous/orca-plugins --ref master
orca plugin install arous.macbook-host-stats
```

`orca plugin catalog add`가 승인 지문을 요구하면 저장소를 확인한 뒤 승인하세요.

로컬 폴더에서 설치:

```sh
cd plugins/macbook-host-stats
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
orca plugin inspect . --json
orca plugin install . --environment local --json
```

`orca plugin install`은 코드 실행 권한 때문에 `approval_required`를 반환할 수 있습니다. `orca plugin inspect . --json`이 보여주는 실행 권한과 저장소를 확인한 뒤에만 Orca가 알려준 정확한 `--approve` 명령을 실행하세요.

## 설정

Settings → Plugins → MacBook Host Stats에서 설정합니다.

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `host` | `macbook2015` | `~/.ssh/config`의 호스트 별칭 |
| `pollSeconds` | `30` | 상태 표시줄 갱신 주기. 15–300초 |

호스트 별칭은 `^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`만 허용합니다. 공백, 세미콜론, `@`, 선행 `-`는 거부하므로 SSH 옵션 주입에 쓰이지 않습니다. 원격 스크립트는 **stdin으로 고정된 내용**을 보내고, 설정값을 셸 문자열에 보간하지 않습니다.

## 구현 경계와 권한

- 실행 프로필은 `trusted-worker`입니다. Orca는 플러그인 코드를 사용자 계정 권한의 별도 Node.js 프로세스에서 실행합니다. 이는 OS 샌드박스가 아닙니다.
- 플러그인은 사용자의 `~/.ssh/config`, SSH 에이전트와 키를 그대로 사용합니다. 키 내용을 읽거나 저장하지 않습니다.
- 원격 명령은 읽기 전용이며 `sudo`를 쓰지 않습니다.
- 선언한 Orca capability는 `settings:own` 하나입니다. 원격 접속 권한은 Orca capability가 아니라 `trusted-worker`의 OS 접근 권한으로 동작합니다.
- SSH 오류의 원문 stderr는 UI나 로그에 남기지 않고 일반 오류 코드로 표시합니다.

## 동작 방식

1. 30초마다(설정값) 하나의 SSH 연결에서 고정 스크립트를 실행합니다.
2. `iostat -c 2 -w 1`의 두 번째 샘플에서 CPU user/sys/idle을 읽습니다. 첫 샘플은 부팅 이후 누적값이므로 사용하지 않습니다.
3. `vm_stat` 페이지 수와 `hw.memsize`로 메모리 사용률을 계산합니다. 사용량은 `active + wired + compressed`, 여유는 `free + inactive + speculative`로 정의합니다.
4. 디스크는 `df -kP /System/Volumes/Data`의 사용률을 그대로 사용합니다. APFS 컨테이너의 예약 공간 때문에 `used / total`과 `df`의 Capacity가 다를 수 있습니다.
5. 네트워크는 기본 라우트 인터페이스의 누적 카운터 차분으로 초당 처리량을 계산합니다. 첫 샘플, 재부팅, 인터페이스 변경 직후에는 rate가 `—`입니다. 커널 부팅 시각도 함께 비교하므로 재부팅 뒤 이전 카운터와 섞이지 않습니다.
6. `netstat` 출력을 읽지 못하면 RX/TX를 0으로 바꾸지 않고 `—`로 표시하며 rate도 만들지 않습니다.
7. SSH 실패가 2회 이상 연속되면 최대 8배까지 재시도 간격을 늘립니다.

`iostat`은 약 1초, 나머지 명령은 수백 밀리초가 걸립니다. 2015년형 MacBook에서 부담을 줄이기 위해 기본 주기를 30초로 두었고, 15초보다 짧게 설정할 수 없습니다. 절전 중인 MacBook은 SSH로 깨울 수 없으므로 마지막 성공 시각과 지연 상태를 표시합니다.

## 개발 및 검증

```sh
orca plugin types . --json
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check
orca plugin validate . --json
orca plugin inspect . --json
```

`npm test`는 다음을 검증합니다.

- 고정 원격 출력 파싱, 메모리·디스크·배터리 계산
- 네트워크 카운터 차분, 카운터 리셋·인터페이스 변경·재부팅 시 rate 제거
- 네트워크 출력 누락 시 0 대신 `—` 처리
- 호스트 별칭 allowlist와 SSH 인자
- 워커의 ready/stale/error 상태, 상태 표시줄, 호스트 변경
- 패널의 정상/지연/오류 렌더와 새로고침

`npm run check`는 `sandbox-exec`로 네트워크를 차단한 상태에서 manifest와 패널을 검사합니다. 워커가 시작되더라도 SSH 연결은 차단되며, 실제 원격 macOS 출력의 전체 경로를 대신하지 않습니다. 실제 `macbook2015` 검증에서는 다음 값을 확인했습니다.

```text
MacBookPro11,4 · Intel i7-4770HQ · 8 logical cores · 16 GB
CPU 8% · memory 28.8% · disk 47% · interface en0
RX 54,788,855,402 bytes · boot 1,793,814,305 · uptime 1,464,188 s
battery 100% AC · top processes 5
```

## 알려진 제한

- 원격 호스트가 절전·종료 상태이거나 Tailscale 연결이 끊기면 조회할 수 없습니다. 호스트 별칭을 바꾸면 이전 호스트의 샘플은 새 호스트 값으로 표시하지 않고 지웁니다.
- `source ~/.ssh/config`의 `Match`, `ProxyJump`, `ControlMaster` 등은 시스템 `ssh` 동작을 그대로 따릅니다. Orca 자체 SSH 연결과 세션을 공유하지는 않습니다.
- CPU 온도·팬·GPU·전력은 root 명령이 필요해 이 플러그인 범위가 아닙니다.
- macOS 버전이나 명령 출력 형식이 바뀌면 파서를 갱신해야 합니다.
- Tailscale `utun` 인터페이스의 트래픽은 기본 라우트 인터페이스(`en0`) 집계에 포함되지 않습니다.

## 라이선스

저장소의 기존 라이선스를 따릅니다.

## 변경 기록

### 0.1.2

- 카드 값을 짧게 줄여 300px 안팎의 사이드바에서도 한 줄로 읽히게 정리.

### 0.1.1

- 좁은 사이드바에서 CPU·메모리·디스크 카드를 한 열로 표시해 값이 세로로 깨지지 않게 수정.
- `orca-catalog.json`으로 GitHub 카탈로그 설치를 지원.
