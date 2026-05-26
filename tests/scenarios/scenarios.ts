/**
 * Concrete scenarios. Each function takes nothing, sets up its own workspace,
 * runs a multi-turn conversation, asserts, tears down, and returns findings.
 *
 * Scenarios are chosen to exercise the high-risk code paths from the last
 * two refactors:
 *   • Language coherence (Chinese in → Chinese out, no English enums leaking)
 *   • Timezone correctness (user's local wins, not server UTC)
 *   • Owner-priority channel engagement
 *   • No channel cards after task creation
 *   • Cancellation localization (→ 已取消, not → CANCELLED)
 *   • Multi-task parsing in one sentence
 *
 * Each scenario asserts on STRUCTURE, not exact wording, because LLM outputs
 * vary turn-to-turn. We check "did CreateTask happen?", "is the deadline in
 * the expected UTC window?", "do captured messages contain any forbidden
 * English-enum strings?" — not "did the AI say exactly X?".
 */

import {
  Assertions,
  CapturedMessage,
  dbTasks,
  setupScenario,
  talk,
  teardownScenario,
} from './harness';
import { Task } from '@prisma/client';

export type ScenarioResult = {
  name: string;
  narrative: string;
  findings: Array<{ level: 'pass' | 'fail' | 'warn'; message: string }>;
  durationMs: number;
};

async function runOne(
  name: string,
  narrative: string,
  body: (a: Assertions) => Promise<void>
): Promise<ScenarioResult> {
  const a = new Assertions();
  const start = Date.now();
  try {
    await body(a);
  } catch (err) {
    a.findings.push({
      level: 'fail',
      message: `THREW: ${(err as Error)?.message ?? String(err)}`,
    });
  }
  return { name, narrative, findings: a.findings, durationMs: Date.now() - start };
}

// ─────────── helpers used by multiple scenarios ───────────

const FORBIDDEN_IN_ZH = [
  /America\/[A-Z]/, // raw IANA in Chinese sentence
  /Europe\/[A-Z]/,
  /Asia\/[A-Z]/,
  /\b(CANCELLED|BLOCKED|COMPLETED|IN_PROGRESS|NOT_STARTED|FAILED|PENDING_CLARIFICATION)\b/,
  /\d{1,2}\/\d{1,2}\/\d{4}/, // American date format
];

function hasCJK(s: string): boolean {
  return /[一-鿿]/.test(s);
}

function joinAll(captured: CapturedMessage[]): string {
  return captured.map((c) => c.rendered ?? c.text ?? '').join('\n---\n');
}

function chineseLanguageIsClean(allText: string): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  for (const pat of FORBIDDEN_IN_ZH) {
    const m = allText.match(pat);
    if (m) offenders.push(`pattern ${pat} matched "${m[0]}"`);
  }
  return { ok: offenders.length === 0, offenders };
}

// ─────────── scenario 1: Chinese task creation in a channel ───────────

export async function scenarioChineseChannelTask(): Promise<ScenarioResult> {
  return runOne(
    'chinese_channel_task',
    '老板在频道里中文说"明天下午6点让Luna做banner"。期望:1 个任务,标题中文,deadline = 用户本地时区明天 18:00,任何捕获消息里都不能出现英文枚举/IANA/美式日期。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'chinese_channel_task',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'Eastern Standard Time',
          display_name: 'Haohua',
        },
        otherUsers: [
          {
            id: 'U03LUNA01A',
            tz: 'America/Los_Angeles',
            tz_label: 'Pacific Standard Time',
            display_name: 'Luna',
          },
        ],
        aliases: [{ alias: 'luna', slackUserId: 'U03LUNA01A' }],
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '明天下午6点让Luna做一个新发布页的 banner',
        });

        const tasks = await dbTasks(ctx);
        a.ok(tasks.length === 1, `Created exactly 1 task`, `Expected 1 task, got ${tasks.length}`);

        if (tasks.length > 0) {
          const t = tasks[0];
          a.ok(
            t.assignee === 'U03LUNA01A',
            `Resolved assignee to U03LUNA01A via alias`,
            `Assignee was ${t.assignee}, expected U03LUNA01A`
          );
          a.ok(
            hasCJK(t.title),
            `Task title is in Chinese: "${t.title}"`,
            `Task title is not in Chinese: "${t.title}"`
          );

          // Deadline: tomorrow 18:00 in America/Detroit. EST is UTC-5, EDT is UTC-4.
          // We tolerate either (test runs may straddle DST boundaries) but the date
          // must be tomorrow's 18:00 ET ± a couple hours.
          const expectedRangeStart = new Date();
          expectedRangeStart.setUTCHours(expectedRangeStart.getUTCHours() + 18); // earliest valid
          const expectedRangeEnd = new Date();
          expectedRangeEnd.setUTCHours(expectedRangeEnd.getUTCHours() + 36); // latest valid
          a.ok(
            t.time >= expectedRangeStart && t.time <= expectedRangeEnd,
            `Deadline is in tomorrow window: ${t.time.toISOString()}`,
            `Deadline ${t.time.toISOString()} is outside expected tomorrow window (${expectedRangeStart.toISOString()} – ${expectedRangeEnd.toISOString()})`
          );

          // Hour-of-day in America/Detroit should be 18:00.
          const hourInDetroit = new Date(t.time.toLocaleString('en-US', { timeZone: 'America/Detroit' })).getHours();
          a.ok(
            hourInDetroit === 18,
            `Deadline is 18:00 in owner's timezone (America/Detroit)`,
            `Deadline is ${hourInDetroit}:00 in America/Detroit, expected 18:00`
          );
        }

        // Language coherence across every captured message.
        const allText = joinAll(ctx.captured);
        const check = chineseLanguageIsClean(allText);
        a.ok(
          check.ok,
          `All captured messages are language-clean (no English enums, IANA, or American dates)`,
          `Found offenders in Chinese output: ${check.offenders.join('; ')}`
        );

        // No channel cards: nothing should have been posted to C_GENERAL with
        // a Block Kit `blocks` field of the old task-card shape (status pill +
        // assignee + due + progress). Heuristic: a card had >= 4 of:
        // emoji-status / assignee / due / progress.
        const channelPosts = ctx.captured.filter(
          (c) => c.method === 'chat.postMessage' && c.channel === 'C_GENERAL'
        );
        const looksLikeCard = (text: string) => {
          let hits = 0;
          if (/status|status:|进度/i.test(text)) hits++;
          if (/Assignee|负责人/i.test(text)) hits++;
          if (/Due|截止/i.test(text)) hits++;
          if (/Progress|░|▓|%/.test(text)) hits++;
          return hits >= 3;
        };
        const cardsInChannel = channelPosts.filter((c) => looksLikeCard(c.rendered ?? ''));
        a.ok(
          cardsInChannel.length === 0,
          `No task cards posted to channel (clean conversational mode)`,
          `Found ${cardsInChannel.length} card-like message(s) in channel: ${cardsInChannel.map((c) => c.rendered?.slice(0, 100)).join(' | ')}`
        );

        // Should be exactly one task — verifies our dedupe fix didn't regress.
        const channelOwnerReplies = channelPosts.filter((c) => c.rendered && c.rendered.length > 0);
        a.ok(
          channelOwnerReplies.length >= 1,
          `Owner got a confirmation in the channel`,
          `Owner got no channel-side confirmation at all`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 2: ambient gate restraint ───────────

export async function scenarioAmbientGateRestraint(): Promise<ScenarioResult> {
  return runOne(
    'ambient_gate_restraint',
    '非老板的员工在频道里聊闲话("早上好,昨晚的比赛真激烈")。期望:bot 不响应,DB 没有新任务,没有发出任何消息。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'ambient_restraint',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03ALICE01', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Alice' },
        ],
      });

      try {
        // NOTE: talk() bypasses the ambient gate (it calls handleConversationTurn
        // directly). To genuinely test the gate we'd need to invoke the Bolt
        // handler. So this scenario is a partial — it checks that an off-topic
        // message at the orchestrator layer still doesn't create a task and
        // doesn't cause a crash. The gate-level test is a TODO for v2 of the
        // harness.
        await talk(ctx, {
          actor: 'U03ALICE01',
          channelId: 'C_RANDOM',
          text: '早上好,昨晚的比赛真激烈',
        });

        const tasks = await dbTasks(ctx);
        a.ok(
          tasks.length === 0,
          `No task created for off-topic chatter`,
          `Off-topic chatter created ${tasks.length} task(s) — bot is over-engaging`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 3: cancel localization ───────────

export async function scenarioCancelLocalized(): Promise<ScenarioResult> {
  return runOne(
    'cancel_localized',
    '老板中文建一个任务,然后中文说"取消那个任务"。期望:UpdateTaskStatus 被调用,状态变成 CANCELLED,但 Slack 上发出的状态公告里是"已取消"不是"CANCELLED"。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'cancel_localized',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LUNA01A', tz: 'America/Los_Angeles', tz_label: 'PST', display_name: 'Luna' },
        ],
        aliases: [{ alias: 'luna', slackUserId: 'U03LUNA01A' }],
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '让 Luna 周五前做个 banner',
        });

        let tasks = await dbTasks(ctx);
        a.ok(tasks.length === 1, `Setup: 1 task created`, `Setup failed: ${tasks.length} tasks`);

        // Cancel
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '取消那个 banner 任务',
        });

        tasks = await dbTasks(ctx);
        a.ok(
          tasks.length === 1 && tasks[0].status === 'CANCELLED',
          `Task status is CANCELLED in DB`,
          `Expected status CANCELLED, got ${tasks.map((t) => t.status).join(', ')}`
        );

        const allText = joinAll(ctx.captured);

        // The cancellation announcement should be localized.
        a.ok(
          /已取消/.test(allText),
          `Cancellation announcement uses 已取消`,
          `No 已取消 found anywhere in captured output`
        );

        a.ok(
          !/→\s*CANCELLED/.test(allText) && !/\bCANCELLED\b/.test(allText),
          `No raw "CANCELLED" enum leaked into Chinese output`,
          `Raw CANCELLED enum is present in captured output — the i18n bypass we just fixed has regressed`
        );

        const check = chineseLanguageIsClean(allText);
        a.ok(
          check.ok,
          `Overall language coherence preserved`,
          `Language mixed: ${check.offenders.join('; ')}`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 4: multi-task in one sentence ───────────

export async function scenarioMultiTask(): Promise<ScenarioResult> {
  return runOne(
    'multi_task_one_sentence',
    '老板一句话两件事:"让 Luna 明天 6pm 出设计稿,Tom 下周二前做完网站"。期望:2 个独立任务,各自负责人正确,deadline 各自正确。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'multi_task',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LUNA01A', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Luna' },
          { id: 'U03TOM01AA', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Tom' },
        ],
        aliases: [
          { alias: 'luna', slackUserId: 'U03LUNA01A' },
          { alias: 'tom', slackUserId: 'U03TOM01AA' },
        ],
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '让 Luna 明天下午 6 点出设计稿,Tom 下周二之前根据设计完成网站',
        });

        const tasks = await dbTasks(ctx);
        a.ok(
          tasks.length === 2,
          `Created 2 separate tasks`,
          `Expected 2 tasks, got ${tasks.length}: ${tasks.map((t) => t.title).join(' | ')}`
        );

        const lunaTask = tasks.find((t) => t.assignee === 'U03LUNA01A');
        const tomTask = tasks.find((t) => t.assignee === 'U03TOM01AA');

        a.ok(!!lunaTask, `Luna got a task`, `No task assigned to U_LUNA`);
        a.ok(!!tomTask, `Tom got a task`, `No task assigned to U_TOM`);

        if (lunaTask && tomTask) {
          a.ok(
            lunaTask.time < tomTask.time,
            `Luna's deadline is earlier than Tom's (correct sequencing)`,
            `Luna due ${lunaTask.time.toISOString()}, Tom due ${tomTask.time.toISOString()} — sequencing inverted`
          );
        }
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 5: clarification on ambiguity ───────────

export async function scenarioAskClarification(): Promise<ScenarioResult> {
  return runOne(
    'ask_clarification_when_ambiguous',
    '老板说"让那位设计师做 banner"——既没指明谁,也没说截止时间。期望:bot 不胡乱创建任务,而是回问澄清问题。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'ask_clarification',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '让那位设计师做个 banner',
        });

        const tasks = await dbTasks(ctx);
        a.ok(
          tasks.length === 0 || tasks.every((t) => t.status === 'PENDING_CLARIFICATION'),
          `No real task created on ambiguous input (got ${tasks.length} pending-clarification entries)`,
          `Created ${tasks.length} fully-formed task(s) despite ambiguity — bot should have asked`
        );

        const allText = joinAll(ctx.captured);
        a.ok(
          /[?？]/u.test(allText),
          `Bot asked at least one clarification question`,
          `No question mark (? or ？) found anywhere in captured output — bot didn't ask`
        );

        a.ok(
          hasCJK(allText),
          `Clarification question was in Chinese`,
          `Clarification was not in Chinese: "${allText.slice(0, 200)}"`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 6: DM from assignee triggers RecordProgress ───────────

export async function scenarioAssigneeReplyRecordsProgress(): Promise<ScenarioResult> {
  return runOne(
    'assignee_reply_records_progress',
    '老板建任务给 Luna。然后 Luna 在 DM 里回复"差不多了,在调色"。期望:RecordProgress 被调用,task.progressPercent 接近 70-90,task.lastProgressSummary 是中文,给老板的 DM 也是中文且没有 card 结构。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'assignee_progress',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LUNA01A', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Luna' },
        ],
        aliases: [{ alias: 'luna', slackUserId: 'U03LUNA01A' }],
      });

      try {
        // Owner creates the task
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '让 Luna 明天 6pm 出设计稿',
        });

        let tasks = await dbTasks(ctx);
        a.ok(tasks.length === 1, `Setup: 1 task created`, `Setup failed: ${tasks.length} tasks`);
        if (tasks.length !== 1) return;

        // Now Luna replies in her DM with the bot. This DM has a fresh
        // channelId — we need to simulate "this is in the DM with Luna and the
        // bot has a recent NudgeProgress breadcrumb for this task" so the AI
        // knows what task the reply is about. We seed that breadcrumb directly
        // into the conversation store the way the scheduler does.
        const { conversationStore } = await import('../../src/orchestrator/conversationStore');
        const lunaDm = 'DU03LUNA01A';
        conversationStore.append(`DM:${lunaDm}`, {
          role: 'assistant',
          content: `ToolResult: ${JSON.stringify({
            name: 'NudgeProgress',
            data: { taskId: tasks[0].id, title: tasks[0].title, assignee: 'U03LUNA01A' },
          })}`,
        });

        await talk(ctx, {
          actor: 'U03LUNA01A',
          channelId: lunaDm,
          text: '差不多了,在调色',
          isDm: true,
        });

        tasks = await dbTasks(ctx);
        const t = tasks[0];
        a.ok(
          t.progressPercent >= 60,
          `Progress percent reflects "almost done" (got ${t.progressPercent}%)`,
          `Progress percent is ${t.progressPercent}%, expected >= 60 for "差不多了"`
        );
        a.ok(
          !!t.lastProgressSummary && hasCJK(t.lastProgressSummary),
          `Owner-facing summary is in Chinese: "${t.lastProgressSummary}"`,
          `Owner-facing summary is not Chinese: "${t.lastProgressSummary}"`
        );

        // Check DM to owner is conversational, not card-style.
        const ownerDms = ctx.captured.filter(
          (c) => c.method === 'chat.postMessage' && c.channel?.startsWith('DU03OWNERHZ')
        );
        const allOwnerText = ownerDms.map((c) => c.rendered ?? '').join('\n');
        const check = chineseLanguageIsClean(allOwnerText);
        a.ok(
          check.ok,
          `Owner DM is in clean Chinese`,
          `Owner DM mixed languages: ${check.offenders.join('; ')}`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 7: English session (mirror language coherence) ───────────

export async function scenarioEnglishSession(): Promise<ScenarioResult> {
  return runOne(
    'english_session_coherent',
    'Owner speaks English: "have Mike finish the launch page by Friday 6pm". Expect: 1 task, English title, deadline = Friday 6pm in owner TZ, no 中文 characters anywhere in captured output.',
    async (a) => {
      const ctx = await setupScenario({
        name: 'english_session',
        owner: {
          id: 'U03OWNER02',
          tz: 'America/Los_Angeles',
          tz_label: 'Pacific Daylight Time',
          display_name: 'Jordan',
        },
        otherUsers: [
          {
            id: 'U03MIKE002',
            tz: 'America/Los_Angeles',
            tz_label: 'Pacific Daylight Time',
            display_name: 'Mike',
          },
        ],
        aliases: [{ alias: 'mike', slackUserId: 'U03MIKE002' }],
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: 'Have Mike finish the launch page by Friday 6pm.',
        });

        const tasks = await dbTasks(ctx);
        a.ok(tasks.length === 1, `Created 1 task`, `Expected 1, got ${tasks.length}`);

        if (tasks.length > 0) {
          const t = tasks[0];
          a.ok(t.assignee === 'U03MIKE002', `Assigned to Mike`, `Assignee was ${t.assignee}`);
          a.ok(
            !hasCJK(t.title),
            `Task title is in English: "${t.title}"`,
            `Task title leaked CJK characters: "${t.title}"`
          );
        }

        const allText = joinAll(ctx.captured);
        // For an English session, the captured output should contain English
        // confirmation and NOT slip into Chinese.
        a.ok(
          !hasCJK(allText),
          `Captured output stays in English (no CJK leakage)`,
          `Output mixed Chinese into an English session — first CJK at position ${allText.search(/[一-鿿]/)}: "${allText.match(/[一-鿿][^]{0,30}/)?.[0]}"`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 8: disambiguation (two aliases for same nickname) ───────────

export async function scenarioDisambiguation(): Promise<ScenarioResult> {
  return runOne(
    'disambiguation_two_aliases',
    '老板说"让 Lisa 做 banner"——但 workspace 里有两个 Lisa。期望:bot 不强行选一个,而是回问"是哪个 Lisa",并提供候选。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'disambig',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LISA0001', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Lisa Wang' },
          { id: 'U03LISA0002', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Lisa Chen' },
        ],
        // Two aliases for "lisa" — both point at different users.
        aliases: [
          { alias: 'lisa', slackUserId: 'U03LISA0001' },
          { alias: 'lisa', slackUserId: 'U03LISA0002' },
        ],
      });

      try {
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '让 Lisa 周五前做个 banner',
        });

        const tasks = await dbTasks(ctx);
        a.ok(
          tasks.length === 0,
          `No task created — bot deferred to ask which Lisa`,
          `Bot created ${tasks.length} task(s) instead of asking — silent guessing`
        );

        const allText = joinAll(ctx.captured);
        a.ok(
          /[?？]/u.test(allText),
          `Bot asked a disambiguation question`,
          `No question mark in captured output — bot didn't ask`
        );
        a.ok(
          /Lisa.*Wang/i.test(allText) || /Lisa.*Chen/i.test(allText) || /1\.|2\./.test(allText),
          `Disambiguation surfaced concrete candidates`,
          `No candidates shown — owner has no way to pick`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 9: opsJudge surfaces silence in Chinese ───────────

export async function scenarioOpsJudgeSilenceZh(): Promise<ScenarioResult> {
  return runOne(
    'ops_judge_silence_chinese',
    '直接调 opsJudge,传入一个中文标题、deadline 临近、assignee 已沉默几小时的任务。期望:返回 surface_silence,message.headline 和 body 都是中文,绝不包含英文枚举。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'ops_silence',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LUNA01A', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Luna' },
        ],
      });

      try {
        // Hand-craft a task that should trigger surface_silence:
        //   - deadline 4 hours away
        //   - we pinged the assignee 6 hours ago
        //   - no progress reply since
        //   - never surfaced silence to the owner before
        const now = Date.now();
        const task = await import('../../src/lib/prisma').then(({ prisma }) =>
          prisma.task.create({
            data: {
              title: '完成发布页设计',
              description: '为产品发布做主视觉',
              time: new Date(now + 4 * 60 * 60 * 1000),
              assignee: 'U03LUNA01A',
              assignees: ['U03LUNA01A'],
              channelId: 'C_GENERAL',
              createdBy: ctx.ownerId,
              initiator: ctx.ownerId,
              teamId: ctx.teamId,
              enterpriseId: ctx.enterpriseId,
              status: 'IN_PROGRESS',
              priority: 'HIGH',
              progressPercent: 30,
              lastProgressSummary: '在出第一版草稿',
              lastProgressAt: new Date(now - 24 * 60 * 60 * 1000),
              progressPingSentAt: new Date(now - 6 * 60 * 60 * 1000),
              lastNudgeAt: new Date(now - 6 * 60 * 60 * 1000),
              createdAt: new Date(now - 48 * 60 * 60 * 1000),
            },
          })
        );

        const { judgeTasks } = await import('../../src/orchestrator/opsJudge');
        const { prisma } = await import('../../src/lib/prisma');
        const decisions = await judgeTasks([task], { prisma, now: new Date(now) });

        a.ok(
          decisions.length === 1,
          `Got 1 decision back from opsJudge`,
          `Got ${decisions.length} decisions, expected 1`
        );

        if (decisions.length > 0) {
          const d = decisions[0];
          a.ok(
            d.action === 'surface_silence' || d.action === 'deadline_heads_up',
            `Action chosen reflects the situation (got "${d.action}")`,
            `Got action "${d.action}" — expected surface_silence or deadline_heads_up given silence + close deadline`
          );

          if (d.message) {
            a.ok(
              hasCJK(d.message.headline) && hasCJK(d.message.body),
              `Message text is in Chinese (headline: "${d.message.headline.slice(0, 30)}…")`,
              `Message text is not Chinese: headline="${d.message.headline}", body="${d.message.body.slice(0, 80)}"`
            );

            const check = chineseLanguageIsClean(`${d.message.headline}\n${d.message.body}`);
            a.ok(
              check.ok,
              `Message language is clean (no English enums / IANA / American dates)`,
              `Language offenders in opsJudge output: ${check.offenders.join('; ')}`
            );
          } else if (d.action !== 'wait') {
            a.findings.push({
              level: 'fail',
              message: `Decision said "${d.action}" but no message attached`,
            });
          }
        }
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 10: ambient gate genuinely tested ───────────

export async function scenarioAmbientGateRealTest(): Promise<ScenarioResult> {
  return runOne(
    'ambient_gate_real',
    '直接调 ambient gate(不绕过),一个工作相关的消息从非老板员工口中说出 → 期望 engage=true;一段办公室闲聊 → 期望 engage=false。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'ambient_real',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03LUNA01A', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Luna' },
        ],
      });

      try {
        // Pre-seed an open task assigned to Luna so the gate has context.
        await (await import('../../src/lib/prisma')).prisma.task.create({
          data: {
            title: 'banner 设计',
            time: new Date(Date.now() + 24 * 60 * 60 * 1000),
            assignee: 'U03LUNA01A',
            assignees: ['U03LUNA01A'],
            channelId: 'C_DESIGN',
            createdBy: ctx.ownerId,
            initiator: ctx.ownerId,
            teamId: ctx.teamId,
            enterpriseId: ctx.enterpriseId,
            status: 'IN_PROGRESS',
            priority: 'NORMAL',
            progressPercent: 30,
          },
        });

        const { shouldEngageAmbient } = await import('../../src/orchestrator/ambientGate');
        const { prisma } = await import('../../src/lib/prisma');

        // Case A: Luna (assignee) posts a status update in the channel — gate
        // should engage so we can RecordProgress.
        const workMsg = await shouldEngageAmbient({
          prisma,
          teamId: ctx.teamId,
          enterpriseId: ctx.enterpriseId,
          channelId: 'C_DESIGN',
          speakerUserId: 'U03LUNA01A',
          text: 'banner 第一版做完了,在调色',
          isSelf: false,
          botUserId: ctx.botUserId,
        });
        a.ok(
          workMsg.engage === true,
          `Gate engaged on work-related update from assignee: why="${workMsg.why}"`,
          `Gate stayed silent on a clearly work-related update — why="${workMsg.why}"`
        );

        // Case B: random small talk from the same person — gate should stay
        // silent.
        const chitchat = await shouldEngageAmbient({
          prisma,
          teamId: ctx.teamId,
          enterpriseId: ctx.enterpriseId,
          channelId: 'C_DESIGN',
          speakerUserId: 'U03LUNA01A',
          text: '今天天气真好,周末有人去爬山吗',
          isSelf: false,
          botUserId: ctx.botUserId,
        });
        a.ok(
          chitchat.engage === false,
          `Gate stayed silent on small talk: why="${chitchat.why}"`,
          `Gate engaged on small talk — that's over-engagement: why="${chitchat.why}"`
        );

        // Case C: a message that @-mentions the bot. The gate should DEFER
        // (engage=false, why='app_mention_handles_this') because the
        // app_mention event handler is the right entry point.
        const mentionMsg = await shouldEngageAmbient({
          prisma,
          teamId: ctx.teamId,
          enterpriseId: ctx.enterpriseId,
          channelId: 'C_DESIGN',
          speakerUserId: ctx.ownerId,
          text: `<@${ctx.botUserId}> 让 Luna 周五前出 banner`,
          isSelf: false,
          botUserId: ctx.botUserId,
        });
        a.ok(
          mentionMsg.engage === false && mentionMsg.why === 'app_mention_handles_this',
          `Gate defers @-mentions to the app_mention handler (why="${mentionMsg.why}")`,
          `Gate engaged on an @-mention — this is the dedupe bug regressing: why="${mentionMsg.why}"`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── scenario 11: bulk delete "all except X" must not miss any ───────────

export async function scenarioBulkDeleteAllExcept(): Promise<ScenarioResult> {
  return runOne(
    'bulk_delete_all_except',
    '老板的 task list 里有 6 个任务,说"除了网站那一个其他全删除"。期望:删 5 个,留 1 个,绝不少删。直接复现 user 反馈里"显示出来多了一个"那个 bug。',
    async (a) => {
      const ctx = await setupScenario({
        name: 'bulk_delete',
        owner: {
          id: 'U03OWNERHZ',
          tz: 'America/Detroit',
          tz_label: 'EST',
          display_name: 'Haohua',
        },
        otherUsers: [
          { id: 'U03YANG001', tz: 'America/Detroit', tz_label: 'EST', display_name: 'Yang' },
        ],
      });

      try {
        // Seed exactly the 6-task scene from the bug report. Five "noise"
        // tasks plus one to keep ("完成网站开发"). Mix of language and titles
        // so the LLM doesn't trivially cluster them.
        const { prisma } = await import('../../src/lib/prisma');
        const now = Date.now();
        const seedTasks = [
          { title: 'Reminder: Eat', priority: 'HIGH' as const, dueOffsetMs: -11 * 24 * 60 * 60 * 1000, description: 'Set a reminder to eat.' },
          { title: 'Eat', priority: 'NORMAL' as const, dueOffsetMs: -60 * 60 * 1000 },
          { title: 'Eat', priority: 'NORMAL' as const, dueOffsetMs: -60 * 60 * 1000 },
          { title: 'Program test - confirm receipt', priority: 'NORMAL' as const, dueOffsetMs: 16 * 60 * 60 * 1000 },
          { title: '确认邮件提醒 / Confirm email reminder', priority: 'NORMAL' as const, dueOffsetMs: 16 * 60 * 60 * 1000 },
          { title: '完成网站开发', priority: 'NORMAL' as const, dueOffsetMs: 36 * 60 * 60 * 1000, assignee: 'U03YANG001' },
        ];
        const created: { id: string; title: string }[] = [];
        for (const t of seedTasks) {
          const row = await prisma.task.create({
            data: {
              title: t.title,
              description: t.description ?? null,
              time: new Date(now + t.dueOffsetMs),
              assignee: t.assignee ?? ctx.ownerId,
              assignees: [t.assignee ?? ctx.ownerId],
              channelId: 'C_GENERAL',
              createdBy: ctx.ownerId,
              initiator: ctx.ownerId,
              teamId: ctx.teamId,
              enterpriseId: ctx.enterpriseId,
              status: 'NOT_STARTED',
              priority: t.priority,
              progressPercent: 0,
            },
          });
          created.push({ id: row.id, title: row.title });
        }

        const websiteTask = created.find((c) => c.title === '完成网站开发')!;

        // First turn: show the list (so the AI has the IDs in working context)
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '我看看任务信息',
        });

        // Second turn: the bug-reproducing instruction.
        await talk(ctx, {
          actor: ctx.ownerId,
          channelId: 'C_GENERAL',
          text: '除了"完成网站开发"那一个,其他全删除掉',
        });

        const surviving = await dbTasks(ctx);
        a.ok(
          surviving.length === 1,
          `Exactly 1 task remains (got ${surviving.length})`,
          `Expected 1 task remaining, got ${surviving.length}: ${surviving.map((t) => t.title).join(' | ')}`
        );
        a.ok(
          surviving.length === 1 && surviving[0].id === websiteTask.id,
          `The surviving task is the website task`,
          `Surviving task is not the website: "${surviving[0]?.title}"`
        );

        // Check the deletion confirmation surfaced the correct count.
        const allText = joinAll(ctx.captured);
        const fiveMentioned =
          /5\s*(个|task)/i.test(allText) || /五/i.test(allText) || /Deleted 5/.test(allText);
        a.warn(
          fiveMentioned,
          `Confirmation message should mention "5" deletions (warning if missing — UX nicety, not a hard requirement)`
        );

        // Hard fail if any "Eat" or other non-website task survived.
        const survivingTitles = surviving.map((t) => t.title);
        a.ok(
          !survivingTitles.some((t) => t === 'Eat' || t === 'Reminder: Eat'),
          `No "Eat" task survived the bulk delete`,
          `An Eat task survived: ${survivingTitles.join(' | ')} — this is the exact reported bug`
        );
      } finally {
        await teardownScenario(ctx);
      }
    }
  );
}

// ─────────── registry ───────────

export const ALL_SCENARIOS = [
  scenarioChineseChannelTask,
  scenarioAmbientGateRestraint,
  scenarioCancelLocalized,
  scenarioMultiTask,
  scenarioAskClarification,
  scenarioAssigneeReplyRecordsProgress,
  scenarioEnglishSession,
  scenarioDisambiguation,
  scenarioOpsJudgeSilenceZh,
  scenarioAmbientGateRealTest,
  scenarioBulkDeleteAllExcept,
];
