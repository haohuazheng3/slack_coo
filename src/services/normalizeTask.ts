// src/services/normalizeTask.ts
// Purpose: Convert GPT output (which may have inconsistent field names and relative times)
// into a normalized object ready for database insertion: { title, time(Date), assignee, channelId, createdBy }

function parseRelativeTimeToDate(input: string, base = new Date()): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  // 1) Try ISO 8601
  const isoTry = new Date(s);
  if (!isNaN(isoTry.getTime())) return isoTry;

  // 2) English relative time: in X minutes / X minutes later
  let m = s.match(/in\s+(\d+)\s*(minute|min|minutes)\b|(\d+)\s*(minute|min|minutes)\s*(later|after)?/);
  if (m) {
    const num = parseInt(m[1] || m[3], 10);
    if (!isNaN(num)) return new Date(base.getTime() + num * 60 * 1000);
  }

  // 3) English relative time: in X hours / X hours later
  m = s.match(/in\s+(\d+)\s*(hour|hours|hr|hrs)\b|(\d+)\s*(hour|hours|hr|hrs)\s*(later|after)?/);
  if (m) {
    const num = parseInt(m[1] || m[3], 10);
    if (!isNaN(num)) return new Date(base.getTime() + num * 60 * 60 * 1000);
  }

  // 4) Chinese relative time: X分钟后
  m = s.match(/(\d+)\s*分钟后/);
  if (m) {
    const num = parseInt(m[1], 10);
    return new Date(base.getTime() + num * 60 * 1000);
  }

  // 5) Chinese relative time: X小时后
  m = s.match(/(\d+)\s*小时后/);
  if (m) {
    const num = parseInt(m[1], 10);
    return new Date(base.getTime() + num * 60 * 60 * 1000);
  }

  return null;
}

export type ParsedTaskInput = {
  title?: string;
  task?: string;
  time?: string;            // Prefer ISO string if available
  reminder_time?: string;   // If user said "2 minutes later", capture this
  assignee?: string;        // Ideally "<@UXXXX>"
  channelId: string;
  createdBy: string;
  rawText?: string;         // Original text, used as fallback
};

export function normalizeToDBTask(input: ParsedTaskInput) {
  const title = (input.title || input.task || '').trim();
  if (!title) throw new Error('Missing task title (title/task)');

  let assignee = (input.assignee || '').trim();
  const idMatch = assignee.match(/U[A-Z0-9]+/i);
  if (idMatch) assignee = idMatch[0];

  let when: Date | null = null;

  if (input.time) {
    const t = new Date(input.time);
    if (!isNaN(t.getTime())) when = t;
  }
  if (!when && input.reminder_time) {
    when = parseRelativeTimeToDate(input.reminder_time);
  }
  if (!when && input.rawText) {
    when = parseRelativeTimeToDate(input.rawText);
  }

  if (!when || isNaN(when.getTime())) {
    throw new Error(`Invalid time. Got time="${input.time}", reminder_time="${input.reminder_time}"`);
  }

  return {
    title,
    time: when,
    assignee,
    channelId: input.channelId,
    createdBy: input.createdBy,
  };
}
