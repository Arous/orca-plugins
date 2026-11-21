import { spawn } from 'node:child_process'
import { parseRemoteMetrics, type RemoteMetrics } from './collector'
import { CollectorError, type CollectorErrorCode } from './errors'

const SSH_PATH = '/usr/bin/ssh'
const TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 64 * 1024
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

/**
 * Fixed remote program. It is sent on stdin so no setting or panel input is ever
 * interpolated into shell syntax. Keep every command read-only and unprivileged.
 */
export const REMOTE_SCRIPT = String.raw`
export LC_ALL=C
printf 'model=%s\n' "$(sysctl -n hw.model 2>/dev/null)"
printf 'ncpu=%s\n' "$(sysctl -n hw.ncpu 2>/dev/null)"
printf 'memsize=%s\n' "$(sysctl -n hw.memsize 2>/dev/null)"
printf 'load=%s\n' "$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
printf 'cpu=%s\n' "$(iostat -c 2 -w 1 2>/dev/null | tr '\r' '\n' | tail -1 | awk '{print $(NF-5), $(NF-4), $(NF-3)}')"
printf 'vm=%s\n' "$(vm_stat 2>/dev/null | awk '
  /page size of/ { gsub(/[^0-9]/,"",$8); pageSize=$8 }
  /Pages free:/ { gsub(/\./,"",$3); freePages=$3 }
  /Pages active:/ { gsub(/\./,"",$3); activePages=$3 }
  /Pages inactive:/ { gsub(/\./,"",$3); inactivePages=$3 }
  /Pages speculative:/ { gsub(/\./,"",$3); speculativePages=$3 }
  /Pages wired down:/ { gsub(/\./,"",$4); wiredPages=$4 }
  /Pages occupied by compressor:/ { gsub(/\./,"",$5); compressedPages=$5 }
  END {
    if (pageSize && freePages != "" && activePages != "" && inactivePages != "" &&
        speculativePages != "" && wiredPages != "" && compressedPages != "")
      printf "%d %d %d %d %d %d %d", pageSize, freePages, activePages, inactivePages,
        speculativePages, wiredPages, compressedPages
  }
')"
printf 'swap=%s\n' "$(sysctl -n vm.swapusage 2>/dev/null)"
printf 'disk=%s\n' "$(df -kP /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $2, $3, $4, $5}')"
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
printf 'iface=%s\n' "$IFACE"
printf 'net=%s\n' "$(netstat -ibn 2>/dev/null | awk -v i="$IFACE" '$1==i && $3 ~ /^<Link/ {print $5, $7, $8, $10; exit}')"
BOOT=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{gsub(/ /,"",$2); print $2; exit}')
printf 'boot=%s\n' "$BOOT"
NOW=$(date +%s)
if [ -n "$BOOT" ] && [ "$BOOT" -gt 0 ] 2>/dev/null; then printf 'uptime=%s\n' "$((NOW-BOOT))"; else printf 'uptime=\n'; fi
printf 'battery=%s\n' "$(pmset -g batt 2>/dev/null | tail -2 | tr '\n' '|')"
printf 'procs=%s\n' "$(ps -Ao pid=,%cpu=,%mem=,command= -ww -r 2>/dev/null | head -20 | sed -E 's/^ *([0-9]+ +[0-9.]+ +[0-9.]+ +[^ ]+).*/\1/' | tr '\n' '|')"
`

export function isValidHost(host: string): boolean {
  return HOST_PATTERN.test(host)
}

export function sshArgs(host: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '--', host,
    '/bin/sh', '-s'
  ]
}

function runSsh(host: string, signal: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let settled = false
  let stdout = ''
  let stdoutBytes = 0
  let timer: NodeJS.Timeout | undefined

  const child = spawn(SSH_PATH, sshArgs(host), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  const finish = (callback: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    callback()
  }

  const terminate = (code: CollectorErrorCode, message: string): void => {
    child.kill('SIGKILL')
    finish(() => reject(new CollectorError(code, message)))
  }

  const abort = (): void => terminate('cancelled', 'cancelled')

  if (signal.aborted) {
    abort()
    return promise
  }
  signal.addEventListener('abort', abort, { once: true })

  timer = setTimeout(() => terminate('timeout', 'timeout'), TIMEOUT_MS)

  child.on('error', () => {
    finish(() => reject(new CollectorError('ssh-failed', 'ssh failed')))
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk)
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      terminate('ssh-failed', 'ssh output too large')
      return
    }
    stdout += chunk
  })

  child.stderr.resume()

  child.on('close', (code) => {
    if (settled) return
    if (code === 0) finish(() => resolve(stdout))
    else finish(() => reject(new CollectorError('ssh-failed', `ssh exited ${code}`)))
  })

  child.stdin.on('error', () => {})
  child.stdin.end(REMOTE_SCRIPT)
  return promise
}

export async function collectRemote(host: string, signal: AbortSignal): Promise<RemoteMetrics> {
  if (!isValidHost(host)) {
    throw new CollectorError('host-invalid', 'invalid host')
  }
  const stdout = await runSsh(host, signal)
  return parseRemoteMetrics(stdout)
}
