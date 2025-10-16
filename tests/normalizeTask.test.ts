import { describe, it, expect } from 'vitest';
import { normalizeToDBTask } from '../src/services/normalizeTask';

function approxEqualTime(a: Date, b: Date, toleranceMs = 2000) {
  expect(Math.abs(a.getTime() - b.getTime())).toBeLessThanOrEqual(toleranceMs);
}

const baseInput = {
  channelId: 'C123',
  createdBy: 'UCREATOR',
};

describe('normalizeToDBTask', () => {
  it('uses ISO time when provided', () => {
    const target = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const out = normalizeToDBTask({
      ...baseInput,
      title: 'ISO test',
      time: target.toISOString(),
      assignee: '<@UAAA111>',
      assignees: [],
    });
    expect(out.title).toBe('ISO test');
    expect(out.assignee).toBe('UAAA111');
    approxEqualTime(out.time, target, 50); // within 50ms of parsed ISO
  });

  it('falls back to reminder_time "in 15 minutes" when ISO is missing', () => {
    const before = new Date();
    const out = normalizeToDBTask({
      ...baseInput,
      title: 'reminder_time test',
      reminder_time: 'in 15 minutes',
      assignee: '<@UBBB222>',
    });
    const after = new Date();
    // expect around 15 minutes from "before" timestamp
    const expectedLower = new Date(before.getTime() + 15 * 60 * 1000 - 2000);
    const expectedUpper = new Date(after.getTime() + 15 * 60 * 1000 + 2000);
    expect(out.time.getTime()).toBeGreaterThanOrEqual(expectedLower.getTime());
    expect(out.time.getTime()).toBeLessThanOrEqual(expectedUpper.getTime());
    expect(out.assignee).toBe('UBBB222');
    expect(out.assignees).toEqual(['UBBB222']);
  });

  it('falls back to rawText "in 2 hours" when neither ISO nor reminder_time usable', () => {
    const before = new Date();
    const out = normalizeToDBTask({
      ...baseInput,
      title: 'rawText test',
      rawText: 'please remind me in 2 hours',
      assignee: '<@UCCC333>',
    });
    const after = new Date();
    const expectedLower = new Date(before.getTime() + 2 * 60 * 60 * 1000 - 2000);
    const expectedUpper = new Date(after.getTime() + 2 * 60 * 60 * 1000 + 2000);
    expect(out.time.getTime()).toBeGreaterThanOrEqual(expectedLower.getTime());
    expect(out.time.getTime()).toBeLessThanOrEqual(expectedUpper.getTime());
    expect(out.assignee).toBe('UCCC333');
  });

  it('extracts multiple assignees from assignees array without duplicating primary', () => {
    const out = normalizeToDBTask({
      ...baseInput,
      title: 'assignees array',
      assignee: '<@UPRIMARY>',
      assignees: ['<@UFOO>', '<@UBAR>'],
      reminder_time: 'in 10 minutes',
    });
    expect(out.assignee).toBe('UPRIMARY');
    expect(out.assignees.sort()).toEqual(['UBAR', 'UFOO'].sort());
  });

  it('defaults to now when times are invalid/missing', () => {
    const before = new Date();
    const out = normalizeToDBTask({
      ...baseInput,
      title: 'default time',
      time: 'not-a-date',
      assignee: '<@UDEF>',
    });
    const after = new Date();
    // Should be "now" per implementation, allow small drift tolerance (~2s)
    expect(out.time.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000);
    expect(out.time.getTime()).toBeLessThanOrEqual(after.getTime() + 2000);
    expect(out.assignee).toBe('UDEF');
    expect(out.assignees).toEqual(['UDEF']);
  });

  it('trims title and selects from title/task fields', () => {
    const out = normalizeToDBTask({
      ...baseInput,
      title: '  Hello  ',
      assignee: '<@UXYZ>',
      reminder_time: 'in 10 minutes',
    });
    expect(out.title).toBe('Hello');
  });
});
