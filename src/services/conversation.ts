import type { ParsedTaskInput } from '../services/normalizeTask';
import { parseRelativeTimeToDate } from '../services/normalizeTask';

type MissingField = 'title' | 'time' | 'assignee';

type PendingContext = {
  channelId: string;
  userId: string;
  payload: ParsedTaskInput;
  missing: MissingField[];
};

const pendingStore = new Map<string, PendingContext>();

function keyOf(channelId: string, userId: string) {
  return `${channelId}:${userId}`;
}

export function getPending(channelId: string, userId: string): PendingContext | null {
  return pendingStore.get(keyOf(channelId, userId)) || null;
}

export function setPending(ctx: PendingContext) {
  pendingStore.set(keyOf(ctx.channelId, ctx.userId), ctx);
}

export function clearPending(channelId: string, userId: string) {
  pendingStore.delete(keyOf(channelId, userId));
}

export function mergePayload(base: ParsedTaskInput, incoming: Partial<ParsedTaskInput>): ParsedTaskInput {
  return {
    title: incoming.title ?? base.title,
    task: incoming.task ?? base.task,
    time: incoming.time ?? base.time,
    reminder_time: incoming.reminder_time ?? base.reminder_time,
    assignee: incoming.assignee ?? base.assignee,
    assignees: incoming.assignees ?? base.assignees,
    channelId: base.channelId,
    createdBy: base.createdBy,
    // Preserve the original utterance to avoid losing intent like "remind me to ..."
    rawText: base.rawText ?? incoming.rawText,
  };
}

export function computeMissing(input: ParsedTaskInput): MissingField[] {
  const missing: MissingField[] = [];
  const title = (input.title || input.task || '').trim();
  if (!title) missing.push('title');

  const hasDirectTime = Boolean((input.time && input.time.trim()) || (input.reminder_time && input.reminder_time.trim()));
  const hasTimeFromRaw = input.rawText ? Boolean(parseRelativeTimeToDate(input.rawText)) : false;
  const hasTime = hasDirectTime || hasTimeFromRaw;
  if (!hasTime) missing.push('time');

  const hasAssignee = Boolean(input.assignee && input.assignee.trim());
  if (!hasAssignee) missing.push('assignee');

  return missing;
}

export function buildFollowupQuestion(ctx: PendingContext): string {
  const title = (ctx.payload.title || ctx.payload.task || '').trim();
  const who = ctx.payload.assignee ? ctx.payload.assignee : '<unspecified>';
  const when = ctx.payload.time || ctx.payload.reminder_time ? (ctx.payload.time || ctx.payload.reminder_time)! : '<unspecified>';

  // Pick the next missing field with priority: time → assignee → title
  const next = (['time','assignee','title'] as MissingField[]).find(f => ctx.missing.includes(f)) ?? ctx.missing[0];
  if (next === 'title') {
    return `Got it so far — assignee is ${who}, time is ${when}. What’s the task in one clear sentence?`;
  }
  if (next === 'time') {
    const prefix = title ? `“${title}”` : 'this task';
    return `When should I schedule ${prefix}? You can give an exact time (e.g., 2025-10-20 09:00) or a relative time (e.g., in 30 minutes / tomorrow 9am).`;
  }
  // assignee
  return `Who should be responsible for this task? If it’s you, say “me”. Otherwise please @ mention the assignee (e.g., @alex).`;
}


