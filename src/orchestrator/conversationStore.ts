type ChatRole = 'user' | 'assistant';

export type ConversationMessage = {
  role: ChatRole;
  content: string;
};

const MAX_MESSAGES_PER_THREAD = 20;

export class ConversationStore {
  private store = new Map<string, ConversationMessage[]>();

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
  }

  clear(threadId: string) {
    this.store.delete(threadId);
  }
}

export const conversationStore = new ConversationStore();

