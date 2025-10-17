import type { ParsedTaskInput } from './normalizeTask';

function normalizeWhitespace(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractMentions(rawText: string): string[] {
  const ids: string[] = [];
  const re = /<@([UW][A-Z0-9]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    ids.push(m[1]);
  }
  return Array.from(new Set(ids));
}

function removeLeadingBotMention(rawText: string, botUserId?: string | null): string {
  if (!botUserId) return rawText;
  return rawText.replace(new RegExp(`^\s*<@${botUserId}>\s*`, 'i'), '').trim();
}

function deriveTitleFromText(rawText: string): string | undefined {
  // Try: "remind me to (.*)"
  let m = rawText.match(/remind\s+me\s+to\s+(.+)/i);
  if (m && m[1]) return normalizeWhitespace(`Remind me to ${m[1]}`);
  // Try: "remind <@U...> to (.*)"
  m = rawText.match(/remind\s+<@([UW][A-Z0-9]+)>\s+to\s+(.+)/i);
  if (m && m[2]) return normalizeWhitespace(`Remind <@${m[1]}> to ${m[2]}`);
  return undefined;
}

function isTimeLikeTitle(text: string): boolean {
  const s = text.trim().toLowerCase();
  if (!s) return false;
  // relative english
  if (/^in\s+\d+\s*(minute|min|minutes|mins|hour|hours|hr|hrs)\b/.test(s)) return true;
  if (/(later|after)\b$/.test(s)) return true;
  // absolute time hints
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(s)) return true;
  if (/\b(today|tomorrow|next\s+\w+)\b/.test(s)) return true;
  // chinese
  if (/\d+\s*(分钟|小时)后/.test(s)) return true;
  return false;
}

function inferAssignee(rawText: string, requesterId: string): string | undefined {
  if (/\bremind\s+me\b/i.test(rawText) || /\bme\b/i.test(rawText)) {
    return requesterId;
  }
  const m = rawText.match(/remind\s+<@([UW][A-Z0-9]+)>/i);
  if (m) return m[1];
  return undefined;
}

export function sanitizeParsedTask(
  rawText: string,
  requesterId: string,
  botUserId: string | null,
  input: ParsedTaskInput
): ParsedTaskInput {
  const cleanedText = removeLeadingBotMention(rawText, botUserId);
  const mentions = extractMentions(cleanedText).filter((id) => id !== botUserId);
  const effectiveTextForTitle = (input.rawText && input.rawText.trim().length > 0) ? input.rawText : cleanedText;

  // Title: prefer LLM title; if missing or too short, derive from text
  let title = normalizeWhitespace(input.title || input.task);
  if (!title || title.length < 3) {
    const derived = deriveTitleFromText(effectiveTextForTitle);
    if (derived) title = derived;
  }
  // If LLM produced a time-like phrase as title, prefer derived title from first utterance
  if (title && isTimeLikeTitle(title)) {
    const derived = deriveTitleFromText(effectiveTextForTitle);
    if (derived) title = derived;
  }

  // Assignee: "remind me" => requester; otherwise try LLM, fallback to text pattern
  let assignee = input.assignee;
  const inferredAssignee = inferAssignee(cleanedText, requesterId);
  if (!assignee && inferredAssignee) {
    assignee = `<@${inferredAssignee}>`;
  }
  if (/\bremind\s+me\b/i.test(cleanedText)) {
    assignee = `<@${requesterId}>`;
  }
  // Default assignee to requester if still missing during follow-up rounds
  if (!assignee) {
    assignee = `<@${requesterId}>`;
  }

  // Assignees list: default to the single responsible person, avoid including recipients
  let assignees = input.assignees && input.assignees.length > 0 ? input.assignees : [];
  const assigneeId = (assignee || '').match(/([UW][A-Z0-9]+)/i)?.[1];
  if (assigneeId) {
    assignees = [`<@${assigneeId}>`];
  }

  // Normalize times text
  const time = normalizeWhitespace(input.time);
  const reminder_time = normalizeWhitespace(input.reminder_time);

  return {
    title,
    task: undefined,
    time,
    reminder_time,
    assignee,
    assignees,
    channelId: input.channelId,
    createdBy: input.createdBy,
    rawText: cleanedText,
  };
}


