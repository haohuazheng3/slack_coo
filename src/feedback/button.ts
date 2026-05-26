/**
 * Injects the 🐞 feedback button into bot-sent messages.
 *
 * Internal-beta UX trade: every bot reply gets a button. Visually clutter-y
 * but very high signal for catching weird-behavior bugs without the user
 * having to screenshot + scroll + paste context. We can dial this back per
 * message type later (e.g. skip on tiny "🗑️ Deleted" confirmations) — for now
 * the rule is simple and uniform.
 *
 * The button carries NO state. At click time we recover everything we need
 * from the Slack action body (channel id, the message they clicked, etc.)
 * and from our own conversationStore + DB. Stateless buttons are much easier
 * to keep right as the rest of the code evolves.
 */

import { detectLanguageFromTexts } from '../lib/i18n';

export type ChatPostMessageLike = {
  channel?: string;
  text?: string;
  blocks?: any[];
  thread_ts?: string;
  [k: string]: any;
};

const BUTTON_LABEL = {
  en: '🐞 Report issue',
  zh: '🐞 反馈问题',
};

/**
 * Append a feedback action block to a chat.postMessage args object. If the
 * args have no blocks but do have text, wrap the text into a section block
 * first so the button has something to sit under. Returns the modified args
 * (does NOT mutate input).
 */
export function withFeedbackButton(args: ChatPostMessageLike): ChatPostMessageLike {
  const text = typeof args.text === 'string' ? args.text : '';
  const hasBlocks = Array.isArray(args.blocks) && args.blocks.length > 0;

  // Detect language from whatever text we have available, to localize the
  // button label. Beta — we're not perfect at this; fall back to English
  // when uncertain.
  const blockText = hasBlocks ? extractBlockText(args.blocks as any[]) : '';
  const lang = detectLanguageFromTexts([text, blockText]);

  let blocks: any[];
  if (hasBlocks) {
    blocks = [...(args.blocks as any[])];
  } else if (text) {
    blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  } else {
    // No text and no blocks — empty message. Don't append a button to nothing.
    return args;
  }

  // Don't double-append if the message already has a feedback button (defensive
  // — could happen if a caller manually included one).
  const alreadyHas = blocks.some(
    (b) =>
      b?.type === 'actions' &&
      Array.isArray(b.elements) &&
      b.elements.some((el: any) => el?.action_id === 'feedback_open')
  );
  if (alreadyHas) return { ...args, blocks };

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: BUTTON_LABEL[lang] },
        action_id: 'feedback_open',
        // Style intentionally NOT 'danger' or 'primary' — it should sit quietly
        // below the actual content, not compete with task action buttons.
      },
    ],
  });

  return { ...args, blocks };
}

function extractBlockText(blocks: any[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b?.text?.text) parts.push(String(b.text.text));
    if (Array.isArray(b?.elements)) {
      for (const el of b.elements) {
        if (el?.text?.text) parts.push(String(el.text.text));
        else if (typeof el?.text === 'string') parts.push(el.text);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Some message types shouldn't carry a feedback button:
 *   - empty / silent replies (handled above by returning args unchanged)
 *   - the feedback flow's own thank-you message (caller can pass skipButton=true)
 *   - the dashboard URL block (caller can opt out)
 *
 * Centralize this so the caller doesn't have to remember the rules.
 */
export function shouldSkipFeedbackButton(args: ChatPostMessageLike): boolean {
  if (!args.text && !args.blocks) return true;
  return false;
}
