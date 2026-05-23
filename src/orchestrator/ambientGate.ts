import { PrismaClient } from '@prisma/client';
import { anthropic, extractText, PRIMARY_MODEL } from '../ai/anthropic';
import { createLogger } from '../lib/logger';

const log = createLogger('AmbientGate');

export type AmbientGateInput = {
  prisma: PrismaClient;
  teamId: string | null;
  enterpriseId: string | null;
  channelId: string;
  speakerUserId: string;
  text: string;
  isSelf: boolean;
  botUserId: string | null;
};

export type AmbientGateResult = {
  engage: boolean;
  /** Short, log-only reason — never shown to humans. */
  why: string;
};

const GATE_SYSTEM_PROMPT = `You are the ambient relevance gate for Aiptima, a Slack chief-of-staff bot.

You decide, for ONE message, whether the bot should engage (i.e. trigger its full reasoning loop and possibly reply). You do NOT reply yourself.

Default: do NOT engage. Speaking up uninvited makes the bot feel like a monitor; staying quiet is almost always the right call. Choose engage only when there is a clear, specific reason.

ENGAGE when:
- The message reads like the owner assigning new work in this room (any phrasing — "have X do Y by Friday", "让小王把那个搞定", "can someone follow up on Z"), AND it's plausibly directed at the room rather than a side aside.
- The speaker is an assignee on an open task in this room and the message reads like a status update / completion / blocker on that task (e.g. "done with the banner", "卡在等设计稿", "I'll finish by tomorrow").
- The owner is asking an open question about the state of open work the bot is tracking ("where are we on the launch?", "is the banner done?").
- The message is a follow-up that obviously belongs to a thread the bot was already in (continuing a conversation).

STAY SILENT when:
- The message is small talk, social chatter, jokes, reactions, file links without action context, etc.
- The message is between two other people about something the bot doesn't have context on.
- The message is plausibly relevant but borderline — when in doubt, stay silent.
- The message is venting / process complaints / metadiscussion about tools — none of that is the bot's job.

Output JSON: { "engage": true|false, "why": "one short phrase, log only" }`;

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    engage: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['engage', 'why'],
  additionalProperties: false,
};

/**
 * "Should I — Aiptima — chime in on this message?"
 *
 * Defaults to NO. The whole point of ambient listening is to feel like a quiet
 * colleague who's working in the corner; speaking up uninvited is far worse than
 * missing a borderline cue.
 */
export async function shouldEngageAmbient(input: AmbientGateInput): Promise<AmbientGateResult> {
  if (input.isSelf) return { engage: false, why: 'self' };

  const trimmed = (input.text ?? '').trim();
  if (!trimmed) return { engage: false, why: 'empty' };

  // Direct @-mention of the bot is an explicit signal — short-circuit. (The
  // app_mention event would also fire for this; we just don't want the gate
  // to second-guess a direct address.)
  if (input.botUserId && trimmed.includes(`<@${input.botUserId}>`)) {
    return { engage: true, why: 'direct_mention' };
  }

  const [openTasksInChannel, openTasksWithSpeaker] = await Promise.all([
    input.prisma.task.findMany({
      where: {
        channelId: input.channelId,
        teamId: input.teamId,
        enterpriseId: input.enterpriseId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING_CLARIFICATION'] },
      },
      select: { id: true, title: true, assignee: true, time: true, status: true },
      orderBy: { time: 'asc' },
      take: 8,
    }),
    input.prisma.task.findMany({
      where: {
        teamId: input.teamId,
        enterpriseId: input.enterpriseId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING_CLARIFICATION'] },
        OR: [
          { assignee: input.speakerUserId },
          { initiator: input.speakerUserId },
          { createdBy: input.speakerUserId },
        ],
      },
      select: { id: true, title: true, assignee: true, initiator: true, time: true, status: true },
      orderBy: { time: 'asc' },
      take: 8,
    }),
  ]);

  const knownAlias = await input.prisma.personAlias.findFirst({
    where: {
      teamId: input.teamId,
      enterpriseId: input.enterpriseId,
      slackUserId: input.speakerUserId,
    },
    orderBy: { confidence: 'desc' },
  });

  const payload = {
    nowIso: new Date().toISOString(),
    message: {
      text: trimmed.slice(0, 1500),
      speakerUserId: input.speakerUserId,
      channelId: input.channelId,
      speakerKnownAs: knownAlias?.alias ?? null,
    },
    openTasksInThisChannel: openTasksInChannel.map((t) => ({
      id: t.id,
      title: t.title,
      assignee: t.assignee,
      dueIso: t.time.toISOString(),
      status: t.status,
    })),
    openTasksInvolvingSpeaker: openTasksWithSpeaker.map((t) => ({
      id: t.id,
      title: t.title,
      assignee: t.assignee,
      initiator: t.initiator,
      dueIso: t.time.toISOString(),
      status: t.status,
      speakerRole:
        t.assignee === input.speakerUserId
          ? 'assignee'
          : t.initiator === input.speakerUserId
            ? 'owner'
            : 'other',
    })),
  };

  let parsed: { engage?: boolean; why?: string };
  try {
    const response = await anthropic.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: 200,
      system: [
        {
          type: 'text',
          text: GATE_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      output_config: {
        format: { type: 'json_schema', schema: GATE_SCHEMA },
      },
    } as any);
    const text = extractText(response);
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn('ambient gate LLM failed — defaulting to silence', { error: String(err) });
    return { engage: false, why: 'gate_unavailable' };
  }

  return {
    engage: Boolean(parsed.engage),
    why: (parsed.why ?? '').slice(0, 120),
  };
}
