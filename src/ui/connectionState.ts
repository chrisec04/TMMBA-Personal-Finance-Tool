import { isStale, type KeyStatus } from '../claude/ClaudePort.ts';

export function shouldAutoVerifyConnection({
  status,
  verificationInFlight,
  now = Date.now(),
}: {
  readonly status: KeyStatus;
  readonly verificationInFlight: boolean;
  readonly now?: number;
}): boolean {
  if (verificationInFlight || !status.configured) return false;
  if (status.connection.state === 'failed') return false;
  if (status.connection.state === 'unverified') return true;
  return isStale(status.connection, now);
}
