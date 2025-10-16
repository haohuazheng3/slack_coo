export function toSlackMention(raw: string) {
  // Try to extract a Slack user ID starting with "U" from the string
  const m = raw.match(/U[A-Z0-9]+/i);
  if (m) return `<@${m[0]}>`;
  // If it’s already in the format <@U...>, just return it
  if (raw.includes('<@') && raw.includes('>')) return raw;
  // Fallback: return the original string
  return raw;
}

export function extractUserId(assignee: string): string | null {
  // Accept "<@U123ABC>" or "U123ABC"
  const m = assignee.match(/<@([A-Z0-9]+)>/i);
  if (m) return m[1];
  if (/^[UW][A-Z0-9]+$/i.test(assignee)) return assignee;
  return null;
}
