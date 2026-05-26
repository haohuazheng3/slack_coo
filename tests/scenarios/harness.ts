/**
 * Scenario test harness — runs realistic user conversations end-to-end against
 * the live Anthropic API and a real Postgres DB, then asserts on the captured
 * Slack messages and resulting DB state.
 *
 * Why not vitest: each scenario is a multi-turn conversation that takes 5–30s
 * (real LLM calls per turn). The narrative flow matters for diagnosing what
 * broke, and standard mocha-style green/red dots don't carry that. This is
 * built as a standalone runner with pretty per-scenario output instead.
 *
 * Why real Anthropic + real DB: mocking the LLM defeats the purpose — the
 * whole point is to exercise judgment quality, language coherence, timezone
 * parsing, etc. Mocking the DB makes Prisma's actual queries impossible to
 * exercise. We use a unique `T_SCEN_*` teamId per scenario so test data is
 * trivially separable from real data, and we clean up in `finally`.
 *
 * Cost note: ~$0.10–0.30 per scenario depending on turn count and how much
 * adaptive thinking Opus 4.7 chooses to do. Six scenarios = ~$1–2 per pass.
 */

import { Task } from '@prisma/client';
import { WebClient } from '@slack/web-api';
import { prisma } from '../../src/lib/prisma';
import { FunctionRegistry } from '../../src/orchestrator/functionRegistry';
import { registerCoreFunctions } from '../../src/functions';
import { handleConversationTurn } from '../../src/orchestrator/handleConversationTurn';
import { conversationStore } from '../../src/orchestrator/conversationStore';

// ─────────── captured Slack side-effects ───────────

export type CapturedMessage = {
  method: 'chat.postMessage' | 'chat.postEphemeral' | 'views.publish' | 'chat.update';
  channel?: string;
  user?: string;
  text?: string;
  blocks?: any[];
  /** Top-level text concatenated with any block mrkdwn text, for easy regex assertions. */
  rendered?: string;
};

// ─────────── user profile mocks ───────────

export type FakeUser = {
  id: string;
  tz: string;
  tz_label: string;
  display_name: string;
};

// ─────────── scenario context ───────────

export type ScenarioContext = {
  scenarioName: string;
  teamId: string;
  enterpriseId: null;
  ownerId: string;
  botUserId: string;
  /** Mock WebClient — every call accumulates in `captured`. */
  client: WebClient;
  captured: CapturedMessage[];
  registry: FunctionRegistry;
  /** Lookup table of fake user profiles (id → tz / display name). */
  users: Map<string, FakeUser>;
};

function renderCapture(args: any): string {
  const parts: string[] = [];
  if (args.text) parts.push(String(args.text));
  if (Array.isArray(args.blocks)) {
    for (const b of args.blocks) {
      if (b?.text?.text) parts.push(String(b.text.text));
      if (Array.isArray(b?.elements)) {
        for (const el of b.elements) {
          if (el?.text?.text) parts.push(String(el.text.text));
          else if (typeof el?.text === 'string') parts.push(el.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function buildMockWebClient(opts: {
  teamId: string;
  botUserId: string;
  users: Map<string, FakeUser>;
}): { client: WebClient; captured: CapturedMessage[] } {
  const captured: CapturedMessage[] = [];

  const client: any = {
    chat: {
      postMessage: async (args: any) => {
        captured.push({
          method: 'chat.postMessage',
          channel: args.channel,
          text: args.text,
          blocks: args.blocks,
          rendered: renderCapture(args),
        });
        return { ok: true, ts: `${(Date.now() / 1000).toFixed(6)}` };
      },
      postEphemeral: async (args: any) => {
        captured.push({
          method: 'chat.postEphemeral',
          channel: args.channel,
          user: args.user,
          text: args.text,
          rendered: args.text,
        });
        return { ok: true };
      },
      update: async (args: any) => {
        captured.push({
          method: 'chat.update',
          channel: args.channel,
          text: args.text,
          blocks: args.blocks,
          rendered: renderCapture(args),
        });
        return { ok: true };
      },
    },
    conversations: {
      open: async (args: any) => {
        const u = Array.isArray(args.users) ? args.users[0] : args.users;
        return { ok: true, channel: { id: `D${u}` } };
      },
    },
    users: {
      info: async (args: any) => {
        const p = opts.users.get(args.user);
        if (!p) return { ok: true, user: null };
        return {
          ok: true,
          user: {
            id: p.id,
            name: p.display_name,
            real_name: p.display_name,
            tz: p.tz,
            tz_label: p.tz_label,
            profile: {
              display_name: p.display_name,
              real_name: p.display_name,
            },
          },
        };
      },
    },
    auth: {
      test: async () => ({
        ok: true,
        team_id: opts.teamId,
        user_id: opts.botUserId,
      }),
    },
    views: {
      publish: async (args: any) => {
        captured.push({
          method: 'views.publish',
          user: args.user_id,
          blocks: args.view?.blocks,
          rendered: JSON.stringify(args.view?.blocks ?? []),
        });
        return { ok: true };
      },
    },
  };

  return { client: client as WebClient, captured };
}

// ─────────── scenario lifecycle ───────────

export async function setupScenario(args: {
  name: string;
  owner: FakeUser;
  otherUsers?: FakeUser[];
  /** Optional: pre-existing person aliases to seed (so resolver finds them). */
  aliases?: Array<{ alias: string; slackUserId: string }>;
}): Promise<ScenarioContext> {
  // Unique workspace id keeps test data trivially separable from any real
  // workspace using the same Postgres instance. Time-stamped suffix avoids
  // collisions when re-running the same scenario quickly.
  const teamId = `T_SCEN_${args.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24)}_${Date.now()}`;
  const enterpriseId = null;
  const botUserId = 'U_TEST_BOT';

  const users = new Map<string, FakeUser>();
  users.set(args.owner.id, args.owner);
  for (const u of args.otherUsers ?? []) users.set(u.id, u);

  const { client, captured } = buildMockWebClient({ teamId, botUserId, users });

  // The bot needs a SlackInstallation row so `getInstallerUserId` works — that
  // function reads `installerUserId` from this table and the owner-priority
  // engagement path depends on knowing who the installer is.
  await prisma.slackInstallation.create({
    data: {
      teamId,
      enterpriseId,
      installerUserId: args.owner.id,
      botId: 'B_TEST',
      botUserId,
      botToken: 'xoxb-test-not-real',
      scopes: 'chat:write,channels:history,im:history',
      isEnterpriseInstall: false,
      raw: {} as any,
    },
  });

  // Pre-seed person aliases if the scenario expects nickname resolution.
  for (const a of args.aliases ?? []) {
    await prisma.personAlias.create({
      data: {
        teamId,
        enterpriseId,
        alias: a.alias.toLowerCase(),
        slackUserId: a.slackUserId,
        kind: 'person',
        source: 'owner_confirmed',
        confidence: 100,
      },
    });
  }

  const registry = new FunctionRegistry();
  registerCoreFunctions(registry);

  return {
    scenarioName: args.name,
    teamId,
    enterpriseId,
    ownerId: args.owner.id,
    botUserId,
    client,
    captured,
    registry,
    users,
  };
}

export async function teardownScenario(ctx: ScenarioContext): Promise<void> {
  // Cascade cleanup. Order matters because of FK constraints.
  await prisma.progressUpdate.deleteMany({ where: { task: { teamId: ctx.teamId } } });
  await prisma.task.deleteMany({ where: { teamId: ctx.teamId } });
  await prisma.personAlias.deleteMany({ where: { teamId: ctx.teamId } });
  await prisma.slackInstallation.deleteMany({ where: { teamId: ctx.teamId } });

  // Clear the in-memory conversation store entries for this scenario's
  // channels so a later scenario doesn't see stale tool-result breadcrumbs.
  // (The store is keyed by channelId+threadTs, not workspace, so we evict
  // aggressively via a TTL of 0.)
  conversationStore.evictStale(0);
}

// ─────────── driving conversation turns ───────────

export type TalkArgs = {
  actor: string; // slack user id (must exist in ctx.users or be an external user id like 'U_RANDOM')
  channelId: string;
  text: string;
  threadTs?: string;
  /** Defaults to inferring from channelId (starts with 'D' → DM). */
  isDm?: boolean;
};

export async function talk(ctx: ScenarioContext, args: TalkArgs): Promise<void> {
  // We bypass Bolt entirely and call handleConversationTurn directly. This is
  // intentional — Bolt's event dispatch isn't what we're testing; the
  // orchestrator's behavior is. But this means the scenario harness does NOT
  // exercise app_mention dedupe / message.* overlap / the ambient gate gate.
  // For those, we'd need a higher-level harness that invokes the Bolt handlers
  // in src/index.ts directly. Out of scope for v1 of this harness.
  await handleConversationTurn({
    client: ctx.client,
    registry: ctx.registry,
    userId: args.actor,
    channelId: args.channelId,
    teamId: ctx.teamId,
    enterpriseId: ctx.enterpriseId,
    threadTs: args.threadTs,
    fallbackTs: `${Date.now() / 1000}`,
    text: args.text,
    triggerHint: 'scenario_test',
  });
}

// ─────────── DB inspection ───────────

export async function dbTasks(ctx: ScenarioContext): Promise<Task[]> {
  return prisma.task.findMany({
    where: { teamId: ctx.teamId },
    orderBy: { createdAt: 'asc' },
  });
}

// ─────────── soft assertions ───────────
//
// Scenarios use `expect`-like helpers, but we don't want a single failure to
// abort the rest of a scenario — we want to see EVERY problem in one pass.
// Each assertion returns a Finding; the runner aggregates them.

export type Finding = {
  level: 'pass' | 'fail' | 'warn';
  message: string;
};

export class Assertions {
  findings: Finding[] = [];

  ok(condition: any, passMsg: string, failMsg: string): boolean {
    if (condition) {
      this.findings.push({ level: 'pass', message: passMsg });
      return true;
    }
    this.findings.push({ level: 'fail', message: failMsg });
    return false;
  }

  warn(condition: any, msg: string): void {
    if (!condition) this.findings.push({ level: 'warn', message: msg });
  }
}
