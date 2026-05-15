import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationStore } from '../src/orchestrator/conversationStore';

describe('ConversationStore', () => {
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore();
  });

  it('append and get round-trip', () => {
    store.append('thread:1', { role: 'user', content: 'hi' });
    store.append('thread:1', { role: 'assistant', content: 'hello' });
    expect(store.get('thread:1')).toHaveLength(2);
    expect(store.get('thread:1')[0]?.content).toBe('hi');
  });

  it('has returns false for unknown thread', () => {
    expect(store.has('nope')).toBe(false);
    store.append('nope', { role: 'user', content: 'x' });
    expect(store.has('nope')).toBe(true);
  });

  it('caps message count to default limit', () => {
    for (let i = 0; i < 60; i++) {
      store.append('t', { role: 'user', content: String(i) });
    }
    const out = store.get('t');
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.at(-1)?.content).toBe('59');
  });

  it('evictStale removes idle threads', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    store.append('old', { role: 'user', content: 'a' });
    vi.setSystemTime(new Date('2026-01-08T00:00:00Z'));
    store.append('fresh', { role: 'user', content: 'b' });

    const evicted = store.evictStale(24 * 60 * 60 * 1000);
    expect(evicted).toBe(1);
    expect(store.has('old')).toBe(false);
    expect(store.has('fresh')).toBe(true);

    vi.useRealTimers();
  });
});
