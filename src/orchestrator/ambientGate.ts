import { PrismaClient } from '@prisma/client';
import { anthropic, extractText, JUDGE_MODEL } from '../ai/anthropic';
import { createLogger } from '../lib/logger';

const AMBIENT_GATE_MODEL = process.env.AMBIENT_GATE_MODEL || JUDGE_MODEL;

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
// Aggressive pre-filter: messages where the answer is obviously "stay silent"
// shouldn't burn an LLM call. Every entry here is a pattern an LLM would
// reliably say "no" on anyway — we just short-circuit before paying for it.
const NOISE_PATTERNS: RegExp[] = [
  // Pure acks and reactions (no work content).
  /^(ok|okay|k|kk|sure|yes|yep|yeah|nope|no|maybe|thanks|thx|ty|got it|nice|cool|lol|lmao|haha|haha+|hahaha+|np|gotcha|alright|right|true|wow|nice one)[!.?]*$/i,
  /^(好|好的|收到|行|嗯|嗯嗯|嗯哼|哦|噢|哈|哈哈|哈哈+|是|对|可以|没事|不错|不行|不|啊|呃|嗨|嘿|哇)[!?。.?！。]*$/,
  // Pure single-word fillers used between thoughts.
  /^(um|uh|hmm|hm|so|well|like|anyway|btw)[.,]?$/i,
];

const WORK_KEYWORDS_EN = [
  'task', 'tasks', 'deadline', 'due', 'finish', 'finished', 'done', 'shipped', 'ship', 'launch',
  'review', 'blocked', 'block', 'progress', 'eod', 'tomorrow', 'today', 'tonight', 'this week',
  'next week', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'assign', 'remind', 'follow up', 'follow-up',
];
const WORK_KEYWORDS_ZH = [
  '任务', '截止', '完成', '做完', '搞定', '交付', '上线', '发布', '复盘', '卡住', '阻塞',
  '进度', '今晚', '今天', '明天', '后天', '本周', '下周', '周一', '周二', '周三', '周四', '周五',
  '周六', '周日', '负责人', '安排', '让', '帮我', '提醒', '麻烦', '记得',
];

function hasWorkKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  if (WORK_KEYWORDS_EN.some((kw) => lower.includes(kw))) return true;
  if (WORK_KEYWORDS_ZH.some((kw) => text.includes(kw))) return true;
  return false;
}

export async function shouldEngageAmbient(input: AmbientGateInput): Promise<AmbientGateResult> {
  if (input.isSelf) return { engage: false, why: 'self' };

  const trimmed = (input.text ?? '').trim();
  if (!trimmed) return { engage: false, why: 'empty' };

  // If the message @-mentions the bot, the `app_mention` event handler is
  // the right entry point — not this one. Slack delivers BOTH events for a
  // channel mention, so if we engaged here too the orchestrator would run
  // twice on the same message. Hand it off cleanly.
  if (input.botUserId && trimmed.includes(`<@${input.botUserId}>`)) {
    return { engage: false, why: 'app_mention_handles_this' };
  }

  // Cheap pre-filter — drop obvious noise BEFORE paying for an LLM call.
  // This is the highest-volume cost saver: in active channels, the majority
  // of messages are short acks, social chatter, single-word reactions. None
  // of those need a Haiku decision; the LLM would reliably say "stay silent"
  // on every one.
  if (trimmed.length <= 4) {
    return { engage: false, why: 'too_short_no_llm' };
  }
  for (const pat of NOISE_PATTERNS) {
    if (pat.test(trimmed)) return { engage: false, why: 'noise_pattern_no_llm' };
  }

  // Slightly longer messages with NO work-keyword AND speaker has no open
  // tasks → almost certainly off-topic chatter, skip the LLM.
  if (trimmed.length <= 30 && !hasWorkKeyword(trimmed)) {
    // We still need to check task context before declaring noise.
    // The query below runs anyway, so this is cheap.
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

  // Second-stage pre-filter (post-DB-lookup, still pre-LLM): if the channel has
  // NO open tasks AND the speaker has NO open tasks AND the message is short
  // with no work keyword — almost certainly off-topic. Skip the LLM. This is
  // the single biggest cost saver for busy channels where the bot is in
  // #general but only really tracks work happening elsewhere.
  if (
    openTasksInChannel.length === 0 &&
    openTasksWithSpeaker.length === 0 &&
    !hasWorkKeyword(trimmed)
  ) {
    return { engage: false, why: 'no_task_context_no_llm' };
  }

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
      model: AMBIENT_GATE_MODEL,
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
