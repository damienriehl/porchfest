// R35's opportunistic trigger runs only at boot or after organizer activity.
// Core still owns eligibility, version guards, anonymization, and receipts.
import type { CoreRuntime } from "@porchfest/core";

export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

interface RetentionSweepOptions {
  readonly now?: () => number;
  readonly defer?: (run: () => void) => void;
  readonly log?: (message: string) => void;
}

export function createRetentionSweep(
  core: Pick<CoreRuntime, "retention">,
  options: RetentionSweepOptions = {},
) {
  // A monotonic clock makes wall-clock corrections irrelevant to throttling;
  // core deliberately keeps wall time for the calendar-month eligibility rule.
  const now = options.now ?? (() => performance.now());
  const defer = options.defer ?? queueMicrotask;
  const log = options.log ?? console.error;
  let lastAttemptAt: number | null = null;
  let deferred = false;

  function run(): void {
    try {
      core.retention.anonymizeEligible();
    } catch {
      // KTD15: database errors can contain participant values or deployment
      // details. A fixed message is enough to make the failed attempt visible.
      log(
        "Retention sweep failed; application startup and organizer work will continue.",
      );
    }
  }

  function onBoot(): void {
    lastAttemptAt = now();
    run();
  }

  function onOrganizerActivity(): boolean {
    const attemptedAt = now();
    if (
      deferred ||
      (lastAttemptAt !== null &&
        attemptedAt - lastAttemptAt < RETENTION_SWEEP_INTERVAL_MS)
    ) {
      return false;
    }

    // Reserve the throttle before deferring so simultaneous organizer requests
    // cannot queue duplicate full scans. Core's receipt guard remains the final
    // idempotence boundary if two processes sweep the same database.
    lastAttemptAt = attemptedAt;
    deferred = true;
    try {
      defer(() => {
        deferred = false;
        run();
      });
    } catch {
      deferred = false;
      log(
        "Retention sweep failed; application startup and organizer work will continue.",
      );
      return false;
    }
    return true;
  }

  return Object.freeze({ onBoot, onOrganizerActivity });
}
