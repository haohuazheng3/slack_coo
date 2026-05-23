/**
 * ConfirmAlias — persist the owner's nickname-to-person binding (product brief §4.2/4.3).
 *
 * Called when the owner explicitly confirms or corrects an assignee:
 *   - "yes, that's the right Lisa"               → confidence=100, source=owner_confirmed
 *   - "no, '小王' is actually 王建国 (<@U…>)"    → same row, just a different slackUserId
 *   - "remember, design = Lisa and Tom"          → two rows, kind='role'
 *
 * This is the moat-building tool. Every call here makes the bot smarter about *this*
 * specific company in a way no competitor can copy without three months of conversation.
 *
 * The AI should call this OPPORTUNISTICALLY — after any disambiguation, after any time the
 * owner volunteers a mapping in passing, and when correcting a wrong auto-learned alias.
 */
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { extractUserId } from '../utils/assignee';
import { persistAlias } from '../services/nicknameResolver';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('ConfirmAlias');

type ConfirmAliasArgs = {
  /** The nickname / role string the owner uses ("小王", "Lisa", "design"). Case-insensitive. */
  alias: string;
  /** "<@U…>" or a bare U-id of the Slack user this alias should resolve to. */
  slackUserId: string;
  /** "person" (default) or "role". A role can map to multiple users via multiple ConfirmAlias calls. */
  kind?: 'person' | 'role';
};

export function confirmAliasFunction(): RegisteredFunction {
  return {
    name: 'ConfirmAlias',
    description:
      "Persist a nickname-to-person mapping the owner just confirmed. Call this AFTER any disambiguation answer, OR when the owner says something like 'remember, 小王 is 王建国', OR when correcting a wrong auto-learned alias. This is how the bot learns this specific company over time.",
    inputExample: '{"alias":"小王","slackUserId":"<@U02A1B2C3D>","kind":"person"}',

    handler: async (args: ConfirmAliasArgs, context) => {
      const alias = (args?.alias ?? '').trim();
      const userIdRaw = (args?.slackUserId ?? '').trim();
      const userId = extractUserId(userIdRaw);
      const kind = args?.kind === 'role' ? 'role' : 'person';

      if (!alias || !userId) {
        return {
          status: 'error',
          message:
            'Both `alias` (the nickname/role string) and `slackUserId` (resolvable to a Slack user id) are required.',
        };
      }

      await persistAlias(
        {
          client: context.slack.client,
          prisma,
          teamId: context.slack.teamId ?? null,
          enterpriseId: context.slack.enterpriseId ?? null,
        },
        alias,
        userId,
        'owner_confirmed',
        100
      );

      // For roles, allow the same call shape to bind multiple users — caller can repeat.
      if (kind === 'role') {
        try {
          await prisma.personAlias.updateMany({
            where: {
              teamId: context.slack.teamId ?? null,
              enterpriseId: context.slack.enterpriseId ?? null,
              alias: alias.toLowerCase(),
              slackUserId: userId,
            },
            data: { kind: 'role' },
          });
        } catch (err) {
          log.warn('Failed to set kind=role', { error: String(err) });
        }
      }

      log.info('Alias confirmed', { alias, userId, kind });

      return {
        status: 'success',
        message: `Got it — I'll remember that "${alias}" means <@${userId}>.`,
        data: { alias, slackUserId: userId, kind, action: 'alias_confirmed' },
      };
    },
  };
}
