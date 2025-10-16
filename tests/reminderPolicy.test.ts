import { describe, it, expect } from 'vitest';
import { computeReminderLeadMs } from '../src/scheduler/reminderPolicy';

const m = 60 * 1000;
const h = 60 * m;

describe('computeReminderLeadMs', () => {
  it('returns 5m lead when deadline is within 10m', () => {
    expect(computeReminderLeadMs(5 * m)).toBe(5 * m);
    expect(computeReminderLeadMs(10 * m)).toBe(5 * m);
  });

  it('returns 10m lead when deadline is within 30m (but over 10m)', () => {
    expect(computeReminderLeadMs(15 * m)).toBe(10 * m);
    expect(computeReminderLeadMs(30 * m)).toBe(10 * m);
  });

  it('returns 30m lead when deadline is within 2h (but over 30m)', () => {
    expect(computeReminderLeadMs(31 * m)).toBe(30 * m);
    expect(computeReminderLeadMs(2 * h)).toBe(30 * m);
    expect(computeReminderLeadMs(90 * m)).toBe(30 * m);
  });

  it('returns 1h lead when deadline is within 6h (but over 2h)', () => {
    expect(computeReminderLeadMs(3 * h)).toBe(60 * m);
    expect(computeReminderLeadMs(6 * h)).toBe(60 * m);
  });

  it('returns 2h lead when deadline is within 24h (but over 6h)', () => {
    expect(computeReminderLeadMs(7 * h)).toBe(2 * h);
    expect(computeReminderLeadMs(24 * h)).toBe(2 * h);
  });

  it('returns 4h lead when deadline is within 72h (but over 24h)', () => {
    expect(computeReminderLeadMs(25 * h)).toBe(4 * h);
    expect(computeReminderLeadMs(72 * h)).toBe(4 * h);
  });

  it('returns 6h lead when deadline is over 72h', () => {
    expect(computeReminderLeadMs(96 * h)).toBe(6 * h);
    expect(computeReminderLeadMs(7 * 24 * h)).toBe(6 * h);
  });
});
