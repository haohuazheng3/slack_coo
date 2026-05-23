import { PrismaClient } from '@prisma/client';

/**
 * Build the "what's going on right now" snippet that gets dropped into the system
 * prompt verbatim. The goal is for the LLM to be able to "read the room" without
 * us imposing a script — so we surface the kinds of signals a real chief of staff
 * would have in their head: who is this person to me, what's already in flight in
 * this room, what did we talk about with them recently.
 *
 * Keep it COMPACT — every token in the system prompt is paid for on every turn.
 * Truncate aggressively, prefer concrete IDs over prose.
 */
export async function buildSituationBlock(args: {
  prisma: PrismaClient;
  teamId: string | null;
  enterpriseId: string | null;
  speakerUserId: string;
  channelId: string;
  isDirectMessage: boolean;
}): Promise<string> {
  const { prisma, teamId, enterpriseId, speakerUserId, channelId, isDirectMessage } = args;

  // 1) Who is the speaker (to *this* workspace's memory)?
  const speakerAliases = await prisma.personAlias.findMany({
    where: { teamId, enterpriseId, slackUserId: speakerUserId },
    orderBy: [{ confidence: 'desc' }, { hitCount: 'desc' }],
    take: 5,
  });

  // 2) Open tasks involving the speaker (as assignee, owner, or creator).
  const speakerTasks = await prisma.task.findMany({
    where: {
      teamId,
      enterpriseId,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] },
      OR: [{ assignee: speakerUserId }, { initiator: speakerUserId }, { createdBy: speakerUserId }],
    },
    orderBy: { time: 'asc' },
    take: 8,
  });

  // 3) Open tasks pinned to *this* channel (channel-level awareness, even if the
  //    speaker isn't a party — the bot might be hearing room-level chatter).
  const channelTasks = isDirectMessage
    ? []
    : await prisma.task.findMany({
        where: {
          channelId,
          teamId,
          enterpriseId,
          status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] },
        },
        orderBy: { time: 'asc' },
        take: 8,
      });

  // 4) Recent progress signals on the speaker's tasks — assignee replies and
  //    our pings, oldest first. Helps the LLM judge "is this another reply or a
  //    new thread?"
  const speakerTaskIds = speakerTasks.map((t) => t.id);
  const recentSignals = speakerTaskIds.length
    ? await prisma.progressUpdate.findMany({
        where: { taskId: { in: speakerTaskIds } },
        orderBy: { createdAt: 'desc' },
        take: 6,
      })
    : [];

  const parts: string[] = [];

  // Speaker identity
  if (speakerAliases.length) {
    const knownAs = speakerAliases.map((a) => `"${a.alias}"`).join(', ');
    parts.push(`Speaker <@${speakerUserId}> is known in this workspace as ${knownAs}.`);
  } else {
    parts.push(`Speaker <@${speakerUserId}> has no recorded alias in this workspace yet.`);
  }

  // Tasks involving the speaker — distinguished by role.
  if (speakerTasks.length) {
    const lines = speakerTasks.map((t) => {
      const role =
        t.assignee === speakerUserId
          ? 'assignee'
          : t.initiator === speakerUserId
            ? 'owner'
            : t.createdBy === speakerUserId
              ? 'creator'
              : 'other';
      return `  - [${t.id}] "${t.title}" — role=${role}, status=${t.status}, due=${t.time.toISOString()}, progress=${t.progressPercent}%${t.lastProgressSummary ? `, last="${t.lastProgressSummary.slice(0, 80)}"` : ''}`;
    });
    parts.push(`Open tasks involving the speaker (${speakerTasks.length}):\n${lines.join('\n')}`);
  } else {
    parts.push(`Open tasks involving the speaker: none.`);
  }

  // Channel-pinned tasks the speaker may not be on (room-level awareness).
  if (channelTasks.length) {
    const otherChannel = channelTasks.filter((t) => !speakerTaskIds.includes(t.id));
    if (otherChannel.length) {
      const lines = otherChannel
        .slice(0, 6)
        .map(
          (t) =>
            `  - [${t.id}] "${t.title}" — assignee=<@${t.assignee}>, status=${t.status}, due=${t.time.toISOString()}`
        );
      parts.push(`Other open tasks pinned to this channel (${otherChannel.length}):\n${lines.join('\n')}`);
    }
  }

  // Recent signals — gives the LLM a sense of whether the speaker is mid-thread.
  if (recentSignals.length) {
    const lines = recentSignals
      .slice()
      .reverse()
      .map(
        (s) =>
          `  - ${s.createdAt.toISOString()} [task ${s.taskId}] source=${s.source}${s.summary ? ` — ${s.summary.slice(0, 100)}` : s.rawText ? ` — "${s.rawText.slice(0, 100)}"` : ''}`
      );
    parts.push(`Recent progress signals on the speaker's tasks (oldest first):\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}
