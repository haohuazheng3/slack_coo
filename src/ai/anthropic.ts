import Anthropic from '@anthropic-ai/sdk';

// dotenv is loaded once in src/index.ts (the entrypoint).
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * PRIMARY_MODEL — Claude Opus 4.7, used for the main orchestrator (every turn
 * a user types). This is the visible AI; quality here is what users perceive.
 *
 * JUDGE_MODEL — Claude Haiku 4.5, used for background judges that don't need
 * Opus-tier reasoning:
 *   - opsJudge (the cron-driven "should I nudge / surface silence / wait")
 *   - ambientGate (the channel-message "should I engage" decision)
 *   - aiSummarizer (employee progress reply → structured owner summary)
 *
 * Why split: at idle (no human typing), opsJudge fires every ~20 min × every
 * workspace, and ambientGate fires on every non-mention channel message.
 * Running Opus there burned ~$3-4/day per workspace on background alone, while
 * the user-visible orchestrator path was a fraction of that. Haiku is 5× cheaper
 * on input AND output, and these tasks (binary engage/silent decisions, JSON
 * extraction from short text, picking from a small enum) are well within its
 * capability. If a judge starts misfiring in production, the right next step is
 * to step up to Sonnet 4.6, not back to Opus 4.7 — see shared/models.md.
 *
 * Set OPS_JUDGE_MODEL / AMBIENT_GATE_MODEL / SUMMARIZER_MODEL env vars to
 * override per-judge if needed.
 */
export const PRIMARY_MODEL = 'claude-opus-4-7';
export const JUDGE_MODEL = 'claude-haiku-4-5';

/**
 * Extract concatenated text from a non-streamed messages.create response.
 * Skips thinking blocks (those are for the model's own reasoning, not
 * user-visible output).
 */
export function extractText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}
