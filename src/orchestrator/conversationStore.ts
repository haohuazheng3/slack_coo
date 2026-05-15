type ChatRole = 'user' | 'assistant';

export type ConversationMessage = {
  role: ChatRole;
  content: string;
};

const MAX_MESSAGES_PER_THREAD = Number(process.env.CONVERSATION_HISTORY_LIMIT ?? '40');

export class ConversationStore {
  private store = new Map<string, ConversationMessage[]>();
  private touched = new Map<string, number>();

  get(threadId: string): ConversationMessage[] {
    return this.store.get(threadId) ?? [];
  }

  has(threadId: string): boolean {
    return this.store.has(threadId);
  }

  append(threadId: string, message: ConversationMessage) {
    const history = this.store.get(threadId) ?? [];
    history.push(message);
    if (history.length > MAX_MESSAGES_PER_THREAD) {
      history.splice(0, history.length - MAX_MESSAGES_PER_THREAD);
    }
    this.store.set(threadId, history);
    this.touched.set(threadId, Date.now());
  }

  clear(threadId: string): void {
    this.store.delete(threadId);
    this.touched.delete(threadId);
  }

  /**
   * Evict conversations older than the given TTL (ms). Call from a low-frequency cron.
   */
  evictStale(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let evicted = 0;
    for (const [key, touchedAt] of this.touched.entries()) {
      if (touchedAt < cutoff) {
        this.store.delete(key);
        this.touched.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}

export const conversationStore = new ConversationStore();
