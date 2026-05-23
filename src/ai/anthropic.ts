import Anthropic from '@anthropic-ai/sdk';

// dotenv is loaded once in src/index.ts (the entrypoint).
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * The only model the product is intended to run on. The user has explicitly
 * chosen to pay Opus 4.7 prices everywhere — no cost-tier downgrades for
 * "cheap" judge calls. If you find yourself wanting to introduce a Haiku or
 * Sonnet fallback "just for this one place", talk to the owner first; the
 * whole point of running Opus across the board is that judgment quality is
 * uniformly high and the bot's restraint is trustworthy.
 */
export const PRIMARY_MODEL = 'claude-opus-4-7';

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
