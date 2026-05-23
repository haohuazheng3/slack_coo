/**
 * Nickname → Slack user resolver (product brief §4.2, 4.3 — the three-layer fallback).
 *
 * The owner does NOT think in Slack user IDs. They think in nicknames and roles ("小王",
 * "Lisa", "design", "the marketing guy"). The product's job is to translate that into a
 * concrete Slack user ID *without* forcing the owner to enroll a roster first (red line #3).
 *
 * Strategy:
 *   1. If the input is already <@U…> or a bare U-id → done.
 *   2. Lookup PersonAlias for this team — confirmed knowledge is the cheapest, most accurate
 *      source. Bump hitCount/lastUsedAt on a hit.
 *   3. Pull the Slack workspace member list (cached per-team) and fuzzy-match against
 *      display_name / real_name / profile.first / profile.title.
 *        - Unique strong match → return it AND quietly persist the alias as `slack_profile`
 *          (low confidence) so we get faster next time. We're explicit to the caller that
 *          this match is provisional ("autoLearned: true") so it can phrase the confirmation
 *          back to the owner ("派给 Lisa 了，不对告诉我").
 *        - Multiple matches / no match → return `needs_disambiguation` with the candidates,
 *          caller asks once via [AskClarification] then persists the answer as
 *          owner_confirmed (highest trust).
 */
import { WebClient } from '@slack/web-api';
import { PrismaClient } from '@prisma/client';
import { extractUserId } from '../utils/assignee';
import { createLogger } from '../lib/logger';

const log = createLogger('NicknameResolver');

type ResolveContext = {
  client: WebClient;
  prisma: PrismaClient;
  teamId: string | null;
  enterpriseId: string | null;
};

export type ResolvedCandidate = {
  slackUserId: string;
  display: string;     // how to show this person to the owner ("Lisa Wang (@lisa.wang)")
  reason: string;      // why we think this matches ("display_name match", "alias hit")
};

export type ResolveResult =
  | { kind: 'resolved'; slackUserId: string; source: 'mention' | 'alias' | 'profile'; autoLearned: boolean }
  | { kind: 'needs_disambiguation'; candidates: ResolvedCandidate[] }
  | { kind: 'not_found' };

// Per-team member-list cache. Cheap to refresh; users.list is paginated and rate-limited so
// we don't want to call it every turn.
type TeamMemberCache = {
  members: SlackMember[];
  fetchedAt: number;
};
type SlackMember = {
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
  title?: string;
  email?: string;
  isBot: boolean;
  deleted: boolean;
};

const MEMBER_CACHE = new Map<string, TeamMemberCache>();
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;

function teamKey(teamId: string | null, enterpriseId: string | null): string {
  return `${teamId ?? '-'}|${enterpriseId ?? '-'}`;
}

async function getTeamMembers(ctx: ResolveContext): Promise<SlackMember[]> {
  const key = teamKey(ctx.teamId, ctx.enterpriseId);
  const cached = MEMBER_CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL_MS) {
    return cached.members;
  }

  const members: SlackMember[] = [];
  let cursor: string | undefined = undefined;
  try {
    do {
      const page: any = await ctx.client.users.list({ limit: 200, cursor });
      for (const m of page.members ?? []) {
        // Skip bots, deleted users, and slackbot
        if (m.is_bot || m.deleted || m.id === 'USLACKBOT') continue;
        members.push({
          id: m.id,
          name: m.name,
          realName: m.real_name,
          displayName: m.profile?.display_name || undefined,
          title: m.profile?.title || undefined,
          email: m.profile?.email || undefined,
          isBot: Boolean(m.is_bot),
          deleted: Boolean(m.deleted),
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (err) {
    log.warn('users.list failed; resolver will degrade to alias-only', { error: String(err) });
  }

  MEMBER_CACHE.set(key, { members, fetchedAt: Date.now() });
  return members;
}

function norm(s: string | undefined | null): string {
  return (s ?? '').toLowerCase().trim();
}

function memberDisplay(m: SlackMember): string {
  const primary = m.displayName || m.realName || m.name || m.id;
  return m.name && m.name !== primary ? `${primary} (@${m.name})` : primary;
}

/**
 * Score how strongly a member matches an alias. Higher = better.
 * 100 = exact display_name match, 60 = substring, 40 = realname-token match.
 * Anything below 40 is rejected — we'd rather ask than guess wrong.
 */
function scoreMember(alias: string, m: SlackMember): { score: number; reason: string } {
  const a = norm(alias);
  if (!a) return { score: 0, reason: '' };
  const dn = norm(m.displayName);
  const rn = norm(m.realName);
  const n = norm(m.name);
  const title = norm(m.title);

  if (dn === a || rn === a || n === a) return { score: 100, reason: 'exact name match' };
  if (dn.startsWith(a) || rn.startsWith(a) || n.startsWith(a))
    return { score: 80, reason: 'name prefix' };

  // Token-level match (handles "Lisa" matching "Lisa Wang" etc.)
  const tokensA = a.split(/\s+/).filter(Boolean);
  const tokensM = [...dn.split(/\s+/), ...rn.split(/\s+/), ...n.split(/\s+/)].filter(Boolean);
  if (tokensA.length === 1 && tokensM.includes(tokensA[0])) {
    return { score: 70, reason: 'name token match' };
  }

  if (dn.includes(a) || rn.includes(a)) return { score: 50, reason: 'name substring' };
  if (title.includes(a)) return { score: 40, reason: 'title match' };
  return { score: 0, reason: '' };
}

const STRONG_MATCH_THRESHOLD = 70;

export async function resolveAssignee(
  input: string,
  ctx: ResolveContext
): Promise<ResolveResult> {
  const raw = (input ?? '').trim();
  if (!raw) return { kind: 'not_found' };

  // ── Layer 1: direct Slack mention or bare user id ────────────────────────────
  const directId = extractUserId(raw);
  if (directId) {
    return { kind: 'resolved', slackUserId: directId, source: 'mention', autoLearned: false };
  }

  const aliasKey = norm(raw);

  // ── Layer 2: persisted alias for this team ───────────────────────────────────
  try {
    const hits = await ctx.prisma.personAlias.findMany({
      where: { teamId: ctx.teamId ?? null, enterpriseId: ctx.enterpriseId ?? null, alias: aliasKey },
      orderBy: [{ confidence: 'desc' }, { hitCount: 'desc' }],
    });

    if (hits.length === 1) {
      // Single confirmed binding. Bump hit count + lastUsedAt and return.
      ctx.prisma.personAlias
        .update({
          where: { id: hits[0].id },
          data: { hitCount: { increment: 1 }, lastUsedAt: new Date() },
        })
        .catch(() => undefined);
      return { kind: 'resolved', slackUserId: hits[0].slackUserId, source: 'alias', autoLearned: false };
    }

    if (hits.length > 1) {
      // Owner uses the same nickname for multiple people. Force a confirm-once.
      const members = await getTeamMembers(ctx);
      const byId = new Map(members.map((m) => [m.id, m]));
      const candidates: ResolvedCandidate[] = hits
        .map((h) => {
          const m = byId.get(h.slackUserId);
          return {
            slackUserId: h.slackUserId,
            display: m ? memberDisplay(m) : h.slackUserId,
            reason: `previous alias (confidence ${h.confidence})`,
          };
        })
        .slice(0, 5);
      return { kind: 'needs_disambiguation', candidates };
    }
  } catch (err) {
    log.warn('PersonAlias lookup failed; falling through to Slack profile match', { error: String(err) });
  }

  // ── Layer 3: live Slack workspace match ──────────────────────────────────────
  const members = await getTeamMembers(ctx);
  if (members.length === 0) return { kind: 'not_found' };

  const scored = members
    .map((m) => ({ member: m, ...scoreMember(raw, m) }))
    .filter((s) => s.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'not_found' };

  const top = scored[0];
  const strongMatches = scored.filter((s) => s.score >= STRONG_MATCH_THRESHOLD);

  if (strongMatches.length === 1) {
    // Unique strong match. Quietly persist as a low-confidence alias so we get
    // faster next time, but mark it autoLearned so the caller can phrase the reply
    // as "I assigned this to Lisa — say so if I got it wrong" rather than silently.
    persistAlias(ctx, aliasKey, top.member.id, 'slack_profile', 70).catch(() => undefined);
    return { kind: 'resolved', slackUserId: top.member.id, source: 'profile', autoLearned: true };
  }

  if (strongMatches.length === 0 && top.score >= 40) {
    // Weak-only matches → present candidates instead of silently picking.
    const candidates: ResolvedCandidate[] = scored.slice(0, 5).map((s) => ({
      slackUserId: s.member.id,
      display: memberDisplay(s.member),
      reason: s.reason,
    }));
    return { kind: 'needs_disambiguation', candidates };
  }

  // Multiple strong matches — must confirm.
  const candidates: ResolvedCandidate[] = strongMatches.slice(0, 5).map((s) => ({
    slackUserId: s.member.id,
    display: memberDisplay(s.member),
    reason: s.reason,
  }));
  return { kind: 'needs_disambiguation', candidates };
}

/**
 * Persist (or upgrade) an alias mapping. Called both:
 *   - silently from Layer 3 when we auto-learn from a profile match (confidence 70),
 *   - explicitly when the owner confirms a disambiguation (confidence 100, source=owner_confirmed).
 */
export async function persistAlias(
  ctx: ResolveContext,
  alias: string,
  slackUserId: string,
  source: 'owner_confirmed' | 'owner_inferred' | 'slack_profile' | 'channel_membership',
  confidence: number
): Promise<void> {
  const key = norm(alias);
  if (!key || !slackUserId) return;
  try {
    // Can't use upsert + compound unique here: Prisma's generated compound-key type
    // rejects null for teamId/enterpriseId, even though the columns are nullable.
    // findFirst → create/update keeps the same semantics with looser type plumbing.
    const existing = await ctx.prisma.personAlias.findFirst({
      where: {
        teamId: ctx.teamId ?? null,
        enterpriseId: ctx.enterpriseId ?? null,
        alias: key,
        slackUserId,
      },
    });

    if (existing) {
      // Owner-confirmed always wins over passively-inferred. Keep the higher confidence.
      await ctx.prisma.personAlias.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(confidence, existing.confidence),
          source,
          lastUsedAt: new Date(),
        },
      });
    } else {
      await ctx.prisma.personAlias.create({
        data: {
          teamId: ctx.teamId ?? null,
          enterpriseId: ctx.enterpriseId ?? null,
          alias: key,
          slackUserId,
          source,
          confidence,
          hitCount: source === 'owner_confirmed' ? 1 : 0,
        },
      });
    }
  } catch (err) {
    log.warn('persistAlias failed', { alias: key, slackUserId, error: String(err) });
  }
}

/** Expose for test / admin tooling — also lets the scheduler reset between test runs. */
export function _clearMemberCache(): void {
  MEMBER_CACHE.clear();
}
