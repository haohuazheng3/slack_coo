export function toSlackMention(raw: string) {
  // Try to extract a Slack user ID starting with "U" from the string
  const m = raw.match(/U[A-Z0-9]+/i);
  if (m) return `<@${m[0]}>`;
  // If it’s already in the format <@U...>, just return it
  if (raw.includes('<@') && raw.includes('>')) return raw;
  // Fallback: return the original string
  return raw;
}
