import { TaskStatus } from '@prisma/client';
import { openai } from '../ai/openaiClient';
import { createLogger } from '../lib/logger';

const log = createLogger('AiSummarizer');

export type EmployeeProgressInterpretation = {

  status: TaskStatus;
  progressPercent: number;
  ownerSummary: string;
  blocker?: string;
};

const SYSTEM_PROMPT = `You are an executive assistant. Given an employee's free-form Slack reply about a task, produce a structured JSON object the owner can scan in 1 second.

Output STRICT JSON with these keys:
  - status: one of NOT_STARTED, IN_PROGRESS, BLOCKED, COMPLETED, FAILED
  - progressPercent: integer 0-100, your best estimate based on the reply
  - ownerSummary: one short sentence (<=140 chars) in the owner's language, third-person, action-oriented, no fluff
  - blocker: optional one short sentence describing what's blocking them, only if status=BLOCKED

Rules:
  - If reply clearly indicates completion (e.g. "done", "finished", "shipped"), status=COMPLETED, progressPercent=100.
  - If reply says they have not started, status=NOT_STARTED, progressPercent=0.
  - If reply describes work in progress without a hard blocker, status=IN_PROGRESS, estimate based on language ("about half" -> 50, "almost done" -> 85, "just started" -> 15).
  - If reply describes a blocker / dependency / waiting on someone, status=BLOCKED. Estimate progressPercent reflecting how far along they were when blocked.
  - If reply says they cannot do it, status=FAILED.
  - ownerSummary must be a neutral, factual paraphrase suitable for a CEO dashboard. Never say "the employee said".`;

export async function interpretEmployeeProgress(args: {
  taskTitle: string;
  taskDescription?: string | null;
  dueAt: Date;
  previousSummary?: string | null;
  employeeReply: string;
}): Promise<EmployeeProgressInterpretation> {
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
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as Partial<EmployeeProgressInterpretation>;

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

function heuristicInterpretation(reply: string): EmployeeProgressInterpretation {
  const lower = reply.toLowerCase();
  if (/(done|finished|completed|shipped|完成|做完|搞定)/.test(lower)) {
    return { status: 'COMPLETED', progressPercent: 100, ownerSummary: 'Reported completion.' };
  }
  if (/(blocked|stuck|waiting|depend|阻塞|卡住|等)/.test(lower)) {
    return {
      status: 'BLOCKED',
      progressPercent: 40,
      ownerSummary: 'Blocked / awaiting dependency.',
      blocker: reply.trim().slice(0, 140),
    };
  }
  if (/(not started|haven['’]t started|没开始|还没)/.test(lower)) {
    return { status: 'NOT_STARTED', progressPercent: 0, ownerSummary: 'Has not started yet.' };
  }
  return {
    status: 'IN_PROGRESS',
    progressPercent: 50,
    ownerSummary: reply.trim().slice(0, 140) || 'Work in progress.',
  };
}
