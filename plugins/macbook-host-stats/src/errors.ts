export type CollectorErrorCode =
  | 'host-invalid'
  | 'ssh-failed'
  | 'timeout'
  | 'cancelled'
  | 'parse-failed'

export class CollectorError extends Error {
  readonly code: CollectorErrorCode

  constructor(code: CollectorErrorCode, message: string) {
    super(message)
    this.name = 'CollectorError'
    this.code = code
  }
}
