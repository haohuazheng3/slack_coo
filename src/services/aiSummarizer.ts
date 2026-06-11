import { TaskStatus } from '@prisma/client';
import { anthropic, extractText, JUDGE_MODEL } from '../ai/anthropic';
import { createLogger } from '../lib/logger';

const SUMMARIZER_MODEL = process.env.SUMMARIZER_MODEL || JUDGE_MODEL;

const log = createLogger('AiSummarizer');

/**
 * "ACKNOWLEDGED" is a synthetic interpretation status that lives only in this
 * module — it never reaches Prisma. It signals "the reply is a bare ack with
 * no progress info, don't fabricate a percent or DM the owner about it".
 */
export type InterpretationStatus = TaskStatus | 'ACKNOWLEDGED';

export type EmployeeProgressInterpretation = {
  status: InterpretationStatus;
  /** null when status === 'ACKNOWLEDGED' — we don't fabricate a number. */
  progressPercent: number | null;
  /** null when status === 'ACKNOWLEDGED' — no DM goes to the owner. */
  ownerSummary: string | null;
  blocker?: string;
};

// A bare acknowledgment is not progress. "好的" / "ok" / "收到" / "稍等" from an
// assignee in response to a NudgeProgress means "I heard you" — it doesn't mean
// they started, or that they're 50% done. Previously we'd send the LLM and it
// would dutifully invent IN_PROGRESS + 50% for these, then DM the owner
// "Luna started on banner — 50%". That's fabricated progress; it violates the
// "facts only" red line and floods the owner with false updates. Short-circuit
// before the LLM ever sees them.
const BARE_ACK_PATTERNS = new Set([
  'ok', 'okay', 'k', 'kk', 'sure', 'yep', 'yes', 'yeah', 'on it', 'got it', 'noted',
  '好', '好的', '收到', '行', '嗯', '稍等', '马上', '在做', '知道了', '了解', '明白', '是的', '对', '可以',
]);
function isBareAck(reply: string): boolean {
  const t = reply.trim().toLowerCase().replace(/[。.！!？?,，~～\s]+$/g, '');
  if (t.length === 0) return true;
  if (t.length <= 4) return true;
  return BARE_ACK_PATTERNS.has(t);
}

const SYSTEM_PROMPT = `You are an executive assistant. Given an employee's free-form Slack reply about a task, produce a structured JSON object the owner can scan in 1 second.

Output JSON with these keys:
  - status: one of NOT_STARTED, IN_PROGRESS, BLOCKED, COMPLETED, FAILED
  - progressPercent: integer 0-100, your best estimate based on the reply
  - ownerSummary: one short sentence (<=140 chars), third-person, action-oriented, no fluff. CRITICAL — write it in the same language as the employee's reply (and the task title). If the reply is in 中文, write the summary in 中文; if English, English. Never default to English.
  - blocker: optional one short sentence describing what's blocking them, only if status=BLOCKED (same language rule)

Rules:
  - If reply clearly indicates completion (e.g. "done", "finished", "shipped", "完成", "搞定"), status=COMPLETED, progressPercent=100.
  - If reply says they have not started, status=NOT_STARTED, progressPercent=0.
  - If reply describes work in progress without a hard blocker, status=IN_PROGRESS, estimate based on language ("about half" / "差不多一半" -> 50, "almost done" / "快好了" -> 85, "just started" / "刚开始" -> 15).
  - If reply describes a blocker / dependency / waiting on someone, status=BLOCKED. Estimate progressPercent reflecting how far along they were when blocked.
  - If reply says they cannot do it, status=FAILED.
  - ownerSummary must be a neutral, factual paraphrase. Never say "the employee said". Never grade — no "slow", "good", "concerning". Just facts.`;

const SUMMARIZER_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'FAILED'],
    },
    progressPercent: { type: 'integer', enum: Array.from({ length: 101 }, (_, i) => i) as number[] },
    ownerSummary: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status', 'progressPercent', 'ownerSummary'],
  additionalProperties: false,
};

export async function interpretEmployeeProgress(args: {
  taskTitle: string;
  taskDescription?: string | null;
  dueAt: Date;
  previousSummary?: string | null;
  employeeReply: string;
}): Promise<EmployeeProgressInterpretation> {
  // Short-circuit on bare acks BEFORE hitting the LLM. Saves a model call AND
  // (more importantly) prevents the model from fabricating progress numbers
  // for "ok" / "好的".
  if (isBareAck(args.employeeReply)) {
    return {
      status: 'ACKNOWLEDGED',
      progressPercent: null,
      ownerSummary: null,
    };
  }

  const userPayload = {
    task: {
      title: args.taskTitle,
      description: args.taskDescription ?? '',
      dueAt: args.dueAt.toISOString(),
      previousSummary: args.previousSummary ?? '',
    },
    employeeReply: args.employeeReply,
  };

  try {
    const response = await anthropic.messages.create({
      model: SUMMARIZER_MODEL,
      max_tokens: 1000,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      output_config: {
        format: { type: 'json_schema', schema: SUMMARIZER_SCHEMA },
      },
    } as any);
    const text = extractText(response);
    const parsed = JSON.parse(text) as Partial<EmployeeProgressInterpretation>;
    return normalizeInterpretation(parsed, args.employeeReply);
  } catch (err) {
    log.warn('AI summarizer failed, falling back to heuristic', { error: String(err) });
    return heuristicInterpretation(args.employeeReply);
  }
}

function normalizeInterpretation(
  parsed: Partial<EmployeeProgressInterpretation>,
  fallbackReply: string
): EmployeeProgressInterpretation {
  const allowed: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'FAILED'];
  const status = (allowed.includes(parsed.status as TaskStatus) ? parsed.status : 'IN_PROGRESS') as TaskStatus;

  let pct = Number(parsed.progressPercent);
  if (!Number.isFinite(pct)) pct = status === 'COMPLETED' ? 100 : status === 'NOT_STARTED' ? 0 : 50;
  pct = Math.max(0, Math.min(100, Math.round(pct)));

  const summary = (parsed.ownerSummary || fallbackReply.trim().slice(0, 140)).trim();

  return {
    status,
    progressPercent: pct,
    ownerSummary: summary,
    blocker: parsed.blocker?.trim() || undefined,
  };
}

/**
 * Re-export the bare-ack test so RecordProgress can mirror the gate at its
 * own layer (e.g. for tests, or if a future call site wants to know "is this
 * even worth recording").
 */
export const isAcknowledgmentOnly = isBareAck;

function heuristicInterpretation(reply: string): EmployeeProgressInterpretation {
  // Last-resort fallback if the LLM is unavailable. Language-aware where it can be,
  // but the LLM path should be hitting in >99% of cases — this is here so a transient
  // API outage doesn't lose an employee's status update entirely.
  const lower = reply.toLowerCase();
  if (/(done|finished|completed|shipped|完成|做完|搞定)/.test(lower)) {
    return { status: 'COMPLETED', progressPercent: 100, ownerSummary: reply.trim().slice(0, 140) };
  }
  if (/(blocked|stuck|waiting|depend|阻塞|卡住|等)/.test(lower)) {
    return {
      status: 'BLOCKED',
      progressPercent: 40,
      ownerSummary: reply.trim().slice(0, 140),
      blocker: reply.trim().slice(0, 140),
    };
  }
  if (/(not started|haven['’]t started|没开始|还没)/.test(lower)) {
    return { status: 'NOT_STARTED', progressPercent: 0, ownerSummary: reply.trim().slice(0, 140) };
  }
  return {
    status: 'IN_PROGRESS',
    progressPercent: 50,
    ownerSummary: reply.trim().slice(0, 140),
  };
}
