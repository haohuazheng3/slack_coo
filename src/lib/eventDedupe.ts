/**
 * Tiny TTL-bounded set for "we already handled this Slack event, drop it."
 *
 * Slack delivers events at-least-once. Two distinct mechanisms can cause us
 * to see the same logical message twice:
 *
 *   1. Slack retries: if Slack didn't get a 200 OK fast enough (e.g. a network
 *      blip between us and Slack's edge), it'll re-POST the event with the
 *      same envelope `event_id`. Bolt's ExpressReceiver auto-acks 200 OK
 *      before our handler runs, so this should be rare — but it does happen.
 *
 *   2. Overlapping event subscriptions: a channel @-mention fires BOTH
 *      `app_mention` AND `message.channels` events with different envelope
 *      IDs but the same underlying message `ts`. We handle the dedupe in
 *      index.ts (the message handler skips @-mention messages explicitly),
 *      but this set is a belt-and-suspenders catch.
 *
 * Keying on `client_msg_id || event_ts || ts` — all three are Slack-assigned
 * IDs unique to the underlying message, so they agree across overlapping
 * subscriptions and Slack retries alike.
 *
 * In-memory only. Process restart → empty set → we briefly re-process
 * anything in flight. Acceptable: the alternative is a Redis dep for a
 * 60-second TTL, which isn't worth it.
 */

const SEEN = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;
const MAX = 5000;

export function markSeenOrSkip(key: string | undefined | null): 'new' | 'duplicate' {
  if (!key) return 'new'; // Can't dedupe without a key — let it through.
  const now = Date.now();
  const seenAt = SEEN.get(key);
  if (seenAt && now - seenAt < TTL_MS) return 'duplicate';

  SEEN.set(key, now);

  if (SEEN.size > MAX) {
    const cutoff = now - TTL_MS;
    for (const [k, v] of SEEN) {
      if (v < cutoff) SEEN.delete(k);
    }
    // If we're STILL over after pruning expired entries, drop the oldest
    // half. This is a degenerate case (>5k events in 5 minutes) but the
    // alternative is unbounded growth.
    if (SEEN.size > MAX) {
      const entries = [...SEEN.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length / 2; i++) {
        SEEN.delete(entries[i][0]);
      }
    }
  }

  return 'new';
}

/**
 * Read a stable Slack-side message identifier out of an event payload.
 * Prefers client_msg_id (set by Slack on user-typed messages), falls back
 * to event_ts / ts.
 */
export function eventDedupeKey(event: any): string | null {
  return event?.client_msg_id || event?.event_ts || event?.ts || null;
}
