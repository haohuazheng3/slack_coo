import { describe, it, expect } from 'vitest';
import { shouldNudgeTask, CadenceInput } from '../src/scheduler/cadencePolicy';

const MIN = 60_000;
const HR = 60 * MIN;

function baseTask(overrides: Partial<CadenceInput> = {}): CadenceInput {
  return {
    status: 'IN_PROGRESS',
    priority: 'NORMAL',
    time: new Date(),
    createdAt: new Date(),
    lastNudgeAt: null,
    lastProgressAt: null,
    progressAutoFailedAt: null,
    ...overrides,
  };
}

describe('shouldNudgeTask — basic states', () => {
  it('does not nudge completed tasks', () => {
    expect(shouldNudgeTask(baseTask({ status: 'COMPLETED' })).shouldNudge).toBe(false);
  });

  it('does not nudge cancelled or failed tasks', () => {
    expect(shouldNudgeTask(baseTask({ status: 'CANCELLED' })).shouldNudge).toBe(false);
    expect(shouldNudgeTask(baseTask({ status: 'FAILED' })).shouldNudge).toBe(false);
  });

  it('does not nudge tasks still in clarification', () => {
    expect(shouldNudgeTask(baseTask({ status: 'PENDING_CLARIFICATION' })).shouldNudge).toBe(false);
  });
});

describe('shouldNudgeTask — cooldown is priority-aware', () => {
  it('NORMAL: nudged 30m ago is still within 4h cooldown', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'NORMAL',
        time: new Date(now.getTime() + 30 * MIN),
        lastNudgeAt: new Date(now.getTime() - 30 * MIN),
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: false, reason: 'too_recent' });
  });

  it('URGENT: nudged 30m ago is already past the 1h cooldown? No (1h cooldown means 30m < 1h)', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'URGENT',
        time: new Date(now.getTime() + 5 * MIN),
        lastNudgeAt: new Date(now.getTime() - 30 * MIN),
      }),
      now
    );
    expect(d.shouldNudge).toBe(false);
    expect(d.reason).toBe('too_recent');
  });

  it('URGENT: nudged 65m ago is past the 1h cooldown and a 5m pre-due fires', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'URGENT',
        time: new Date(now.getTime() + 5 * MIN),
        lastNudgeAt: new Date(now.getTime() - 65 * MIN),
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'pre_due' });
  });
});

describe('shouldNudgeTask — pre_due / overdue', () => {
  it('NORMAL: 30 min before due triggers pre_due', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        time: new Date(now.getTime() + 15 * MIN),
        createdAt: new Date(now.getTime() - 2 * HR),
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'pre_due' });
  });

  it('URGENT: pre_due window is 60 min (45 min before due fires)', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'URGENT',
        time: new Date(now.getTime() + 45 * MIN),
        createdAt: new Date(now.getTime() - 2 * HR),
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'pre_due' });
  });

  it('NORMAL: 45 min before due is OUTSIDE the 30-min window', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'NORMAL',
        time: new Date(now.getTime() + 45 * MIN),
        createdAt: new Date(now.getTime() - 2 * HR),
      }),
      now
    );
    expect(d.shouldNudge).toBe(false);
  });

  it('overdue tasks fire overdue', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        time: new Date(now.getTime() - 10 * MIN),
        createdAt: new Date(now.getTime() - 2 * HR),
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'overdue' });
  });
});

describe('shouldNudgeTask — mid-window for medium tasks (4-24h)', () => {
  it('NORMAL: at half-window with no recent progress fires scheduled', () => {
    const now = new Date();
    const d = shouldNudgeTask(
      baseTask({
        priority: 'NORMAL',
        time: new Date(now.getTime() + 6 * HR),
        createdAt: new Date(now.getTime() - 6 * HR),
        lastProgressAt: null,
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'scheduled' });
  });

  it('URGENT: fires earlier (at 33% of window)', () => {
    const now = new Date();
    const dueAt = new Date(now.getTime() + 6 * HR);
    const createdAt = new Date(now.getTime() - 3 * HR);

    const d = shouldNudgeTask(
      baseTask({
        priority: 'URGENT',
        time: dueAt,
        createdAt,
        lastProgressAt: null,
      }),
      now
    );
    expect(d).toEqual({ shouldNudge: true, reason: 'scheduled' });
  });
});
