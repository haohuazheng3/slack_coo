import { Task, TaskPriority } from '@prisma/client';

export type NudgeDecision = {
  shouldNudge: boolean;
  reason: 'scheduled' | 'pre_due' | 'overdue' | 'cooldown' | 'completed' | 'too_recent';
};

const MIN = 60 * 1000;
const HR = 60 * MIN;
const DAY = 24 * HR;

const DAILY_NUDGE_HOUR = Number(process.env.PROGRESS_NUDGE_HOUR ?? '10');
const URGENT_SECOND_HOUR = Number(process.env.PROGRESS_NUDGE_URGENT_SECOND_HOUR ?? '15');

/**
 * Priority-aware tuning.
 *  - URGENT: short cooldown (1h), longer pre-due window (60m), 2 daily check-ins for multi-day tasks.
 *  - HIGH:   2h cooldown, 45m pre-due window.
 *  - NORMAL: 4h cooldown, 30m pre-due window.
 *  - LOW:    8h cooldown, 30m pre-due window, only daily nudge once a day.
 */
type PriorityCadence = {
  cooldownMs: number;
  preDueWindowMs: number;

  dailyHours: number[];

  midWindowSinceProgressMs: number;
  midWindowFraction: number;
};

const PRIORITY_TUNING: Record<TaskPriority, PriorityCadence> = {
  URGENT: {
    cooldownMs: 1 * HR,
    preDueWindowMs: 60 * MIN,
    dailyHours: [DAILY_NUDGE_HOUR, URGENT_SECOND_HOUR],
    midWindowSinceProgressMs: 2 * HR,
    midWindowFraction: 1 / 3,
  },
  HIGH: {
    cooldownMs: 2 * HR,
    preDueWindowMs: 45 * MIN,
    dailyHours: [DAILY_NUDGE_HOUR],
    midWindowSinceProgressMs: 4 * HR,
    midWindowFraction: 0.5,
  },
  NORMAL: {
    cooldownMs: Number(process.env.MIN_NUDGE_INTERVAL_MS ?? `${4 * HR}`),
    preDueWindowMs: 30 * MIN,
    dailyHours: [DAILY_NUDGE_HOUR],
    midWindowSinceProgressMs: 6 * HR,
    midWindowFraction: 0.5,
  },
  LOW: {
    cooldownMs: 8 * HR,
    preDueWindowMs: 30 * MIN,
    dailyHours: [DAILY_NUDGE_HOUR],
    midWindowSinceProgressMs: 12 * HR,
    midWindowFraction: 0.6,
  },
};

export type CadenceInput = Pick<
  Task,
  | 'status'
  | 'time'
  | 'createdAt'
  | 'lastNudgeAt'
  | 'lastProgressAt'
  | 'progressAutoFailedAt'
  | 'priority'
>;

/**
 * Decide whether a nudge should be sent for the given task at the current time.
 *
 * Strategy (priority-aware):
 *   - Completed / cancelled / failed / awaiting-clarification tasks never get nudged.
 *   - Cooldown enforced by priority (URGENT=1h ... LOW=8h).
 *   - If task is overdue: send 'overdue' (subject to cooldown).
 *   - Within priority-specific pre-due window before due: send 'pre_due'.
 *   - Multi-day tasks (> 24h): nudge at PROGRESS_NUDGE_HOUR (and a second time for URGENT).
 *   - Mid-length tasks (4–24h): nudge once past the priority's mid-window fraction
 *     IF no employee update for longer than midWindowSinceProgressMs.
 *   - Short tasks (< 4h until due): only pre_due nudges.
 */
export function shouldNudgeTask(
  task: CadenceInput,
  now: Date = new Date()
): NudgeDecision {
  if (
    task.status === 'COMPLETED' ||
    task.status === 'CANCELLED' ||
    task.status === 'FAILED' ||
    task.status === 'PENDING_CLARIFICATION'
  ) {
    return { shouldNudge: false, reason: 'completed' };
  }

  const tuning = PRIORITY_TUNING[task.priority] ?? PRIORITY_TUNING.NORMAL;
  const nowMs = now.getTime();
  const dueMs = task.time.getTime();
  const msUntilDue = dueMs - nowMs;

  const lastNudgeMs = task.lastNudgeAt?.getTime() ?? 0;
  if (lastNudgeMs > 0 && nowMs - lastNudgeMs < tuning.cooldownMs) {
    return { shouldNudge: false, reason: 'too_recent' };
  }

  if (msUntilDue < 0 && Math.abs(msUntilDue) < 7 * DAY) {
    return { shouldNudge: true, reason: 'overdue' };
  }

  if (msUntilDue >= 0 && msUntilDue <= tuning.preDueWindowMs) {
    return { shouldNudge: true, reason: 'pre_due' };
  }

  const sinceProgress = task.lastProgressAt ? nowMs - task.lastProgressAt.getTime() : Infinity;
  const currentHour = now.getHours();

  if (msUntilDue > 24 * HR) {
    const inDailyWindow = tuning.dailyHours.includes(currentHour);
    const sameSlotAlreadyNudged =
      !!task.lastNudgeAt &&
      isSameLocalDay(task.lastNudgeAt, now) &&
      task.lastNudgeAt.getHours() === currentHour;
    const updatedSinceWindow =
      !!task.lastProgressAt && nowMs - task.lastProgressAt.getTime() < tuning.cooldownMs;
    if (inDailyWindow && !sameSlotAlreadyNudged && !updatedSinceWindow) {
      return { shouldNudge: true, reason: 'scheduled' };
    }
    return { shouldNudge: false, reason: 'cooldown' };
  }

  if (msUntilDue > 4 * HR && msUntilDue <= 24 * HR) {
    const totalWindow = dueMs - task.createdAt.getTime();
    const elapsed = nowMs - task.createdAt.getTime();
    const reachedThreshold = elapsed >= totalWindow * tuning.midWindowFraction;
    const longSinceProgress = sinceProgress > tuning.midWindowSinceProgressMs;
    if (reachedThreshold && longSinceProgress) {
      return { shouldNudge: true, reason: 'scheduled' };
    }
    return { shouldNudge: false, reason: 'cooldown' };
  }

  return { shouldNudge: false, reason: 'cooldown' };
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
