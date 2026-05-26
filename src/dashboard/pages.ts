import type { Task, TaskStatus } from '@prisma/client';
import { detectLanguageFromTexts } from '../lib/i18n';
import { toSlackMention } from '../utils/assignee';
import { formatDateTime } from '../lib/timezone';
import { DashboardSnapshot } from './data';

type Lang = 'en' | 'zh';

type DashCopy = {
  meta: { title: string };
  nav: { back: string };
  hero: { greeting: string; sub: string };
  tiles: { open: string; blocked: string; overdue: string; doneThisWeek: string };
  sections: {
    risks: string;
    risksLead: string;
    active: string;
    activeLead: string;
    completed: string;
    workload: string;
    workloadLead: string;
    activity: string;
    activityLead: string;
    empty: string;
  };
  card: {
    due: string;
    overdueTag: string;
    progress: string;
    lastUpdate: string;
    noUpdates: string;
    assignee: string;
    blockedReason: string;
    days: string;
    hours: string;
    minutes: string;
    inFuture: string;
    ago: string;
  };
  workload: { tasksWord: string; blockedSuffix: string; overdueSuffix: string; loadTag: string };
  activity: { sourceEmployee: string; sourceSystem: string; sourceAi: string; sourceOwner: string };
  expired: {
    title: string;
    body: string;
    howTo: string;
  };
  status: Record<TaskStatus, string>;
};

const COPY: Record<Lang, DashCopy> = {
  en: {
    meta: { title: 'Dashboard · Aiptima' },
    nav: { back: 'Open Slack' },
    hero: {
      greeting: 'Here is what is on your plate.',
      sub: "Open work, the people carrying it, and what's changed lately. Aiptima keeps the record; you keep the calls.",
    },
    tiles: {
      open: 'Open',
      blocked: 'Blocked',
      overdue: 'Overdue',
      doneThisWeek: 'Done this week',
    },
    sections: {
      risks: 'Needs your attention',
      risksLead:
        'Tasks that are overdue, blocked, or quiet for too long after a check-in. Facts only — the call is yours.',
      active: 'In flight',
      activeLead: 'Everything currently moving, sorted by deadline.',
      completed: 'Recently completed',
      workload: 'Who is carrying what',
      workloadLead: 'Open task count per assignee. Higher bar = heavier load right now.',
      activity: 'Recent activity',
      activityLead: 'The last few signals across all tasks — employee replies, system pings, summaries.',
      empty: 'Nothing here right now.',
    },
    card: {
      due: 'Due',
      overdueTag: 'overdue',
      progress: 'Progress',
      lastUpdate: 'Last update',
      noUpdates: 'No updates yet',
      assignee: 'Assignee',
      blockedReason: 'Reason',
      days: 'd',
      hours: 'h',
      minutes: 'm',
      inFuture: 'in',
      ago: 'ago',
    },
    workload: {
      tasksWord: 'open',
      blockedSuffix: 'blocked',
      overdueSuffix: 'overdue',
      loadTag: 'heaviest load',
    },
    activity: {
      sourceEmployee: 'reply',
      sourceSystem: 'system',
      sourceAi: 'summary',
      sourceOwner: 'you',
    },
    expired: {
      title: 'This link expired.',
      body: 'Dashboard links are short-lived for security. Re-open it from Slack to get a fresh one.',
      howTo: 'In Slack: open the Aiptima Home tab and tap "Open in browser".',
    },
    status: {
      PENDING_CLARIFICATION: 'Awaiting input',
      NOT_STARTED: 'Not started',
      IN_PROGRESS: 'In progress',
      BLOCKED: 'Blocked',
      COMPLETED: 'Completed',
      FAILED: 'Not completed',
      CANCELLED: 'Cancelled',
    },
  },
  zh: {
    meta: { title: '看板 · Aiptima' },
    nav: { back: '回到 Slack' },
    hero: {
      greeting: '今天你的事在这里。',
      sub: '正在跑的活、谁在扛、最近变了什么。Aiptima 帮你记账,判断权留给你。',
    },
    tiles: {
      open: '进行中',
      blocked: '受阻',
      overdue: '逾期',
      doneThisWeek: '本周已完成',
    },
    sections: {
      risks: '需要你过一眼',
      risksLead: '已逾期、受阻、或上次问完之后长时间没回的任务。只摆事实,判断权交给你。',
      active: '进行中',
      activeLead: '所有还没收尾的活,按截止时间排序。',
      completed: '最近完成',
      workload: '谁在扛什么',
      workloadLead: '每个负责人当前未完成的任务数。条越长,当下负担越重。',
      activity: '最近动态',
      activityLead: '所有任务上的最新信号——员工回复、系统提醒、AI 摘要。',
      empty: '当前没有内容。',
    },
    card: {
      due: '截止',
      overdueTag: '已逾期',
      progress: '进度',
      lastUpdate: '上次更新',
      noUpdates: '暂无更新',
      assignee: '负责人',
      blockedReason: '原因',
      days: '天',
      hours: '小时',
      minutes: '分钟',
      inFuture: '后',
      ago: '前',
    },
    workload: {
      tasksWord: '进行中',
      blockedSuffix: '受阻',
      overdueSuffix: '逾期',
      loadTag: '负担最重',
    },
    activity: {
      sourceEmployee: '员工回复',
      sourceSystem: '系统',
      sourceAi: 'AI 摘要',
      sourceOwner: '你',
    },
    expired: {
      title: '链接已过期。',
      body: '看板链接为了安全只短期有效。回到 Slack 重新打开就能拿到新的链接。',
      howTo: '在 Slack 里:打开 Aiptima 的 Home 标签,点"在浏览器打开"。',
    },
    status: {
      PENDING_CLARIFICATION: '等待补充',
      NOT_STARTED: '未开始',
      IN_PROGRESS: '进行中',
      BLOCKED: '受阻',
      COMPLETED: '已完成',
      FAILED: '未完成',
      CANCELLED: '已取消',
    },
  },
};

const STATUS_TONE: Record<TaskStatus, 'open' | 'blocked' | 'done' | 'risk' | 'other'> = {
  PENDING_CLARIFICATION: 'other',
  NOT_STARTED: 'open',
  IN_PROGRESS: 'open',
  BLOCKED: 'blocked',
  COMPLETED: 'done',
  FAILED: 'risk',
  CANCELLED: 'other',
};

/**
 * Inline stylesheet for the dashboard. Same blue/Stripe-ish design vocabulary
 * as the install landing page — variables and base look match deliberately so
 * the two surfaces feel like the same product. Dashboard-specific components
 * (summary tiles, task cards, workload bars, activity timeline) live below.
 */
const STYLES = `
<style>
  :root {
    --bg: #ffffff;
    --bg-soft: #f8fafc;
    --ink: #0f172a;
    --ink-muted: #475569;
    --ink-faint: #94a3b8;
    --border: #e2e8f0;
    --border-soft: #f1f5f9;
    --brand: #2563eb;
    --brand-hover: #1d4ed8;
    --brand-soft: #eff6ff;
    --green: #16a34a;
    --green-soft: #f0fdf4;
    --amber: #d97706;
    --amber-soft: #fffbeb;
    --red: #dc2626;
    --red-soft: #fef2f2;
    --slate: #64748b;
    --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 32px rgba(15, 23, 42, 0.06);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI",
                 system-ui, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    background: var(--bg-soft);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--brand); text-decoration: none; }
  a:hover { color: var(--brand-hover); }

  nav.top {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 32px;
    max-width: 1280px; margin: 0 auto;
    background: var(--bg);
    border-bottom: 1px solid var(--border-soft);
  }
  .brand-mark {
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 700; font-size: 16px; color: var(--ink); letter-spacing: -0.01em;
  }
  .brand-dot {
    width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--brand) 0%, #4f46e5 100%);
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.4);
  }
  .nav-right {
    display: inline-flex; align-items: center; gap: 12px;
  }
  .lang-switch {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 13px; color: var(--ink-faint); font-weight: 500;
  }
  .lang-switch a {
    padding: 4px 8px; border-radius: 6px;
    color: var(--ink-faint);
  }
  .lang-switch a:hover { color: var(--ink); background: var(--border-soft); }
  .lang-switch a.active {
    color: var(--brand); background: var(--brand-soft); font-weight: 600;
  }
  .lang-switch .sep { color: var(--ink-faint); opacity: 0.5; }

  .shell {
    max-width: 1280px; margin: 0 auto;
    padding: 32px 32px 64px;
  }

  /* ─────────── hero ─────────── */
  .hero {
    margin: 8px 0 32px;
  }
  .hero h1 {
    font-size: clamp(26px, 3vw, 34px);
    font-weight: 700; letter-spacing: -0.02em; line-height: 1.2;
    margin: 0 0 10px; color: var(--ink);
  }
  .hero p {
    color: var(--ink-muted); margin: 0; font-size: 15px; max-width: 720px;
  }

  /* ─────────── summary tiles ─────────── */
  .tiles {
    display: grid; gap: 16px;
    grid-template-columns: repeat(2, 1fr);
    margin-bottom: 40px;
  }
  @media (min-width: 720px) {
    .tiles { grid-template-columns: repeat(4, 1fr); }
  }
  .tile {
    background: var(--bg); border: 1px solid var(--border-soft);
    border-radius: 12px; padding: 20px;
  }
  .tile .label {
    font-size: 12px; color: var(--ink-faint); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .tile .value {
    font-size: 36px; font-weight: 800; letter-spacing: -0.03em;
    color: var(--ink); margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  .tile.warn .value { color: var(--amber); }
  .tile.alert .value { color: var(--red); }
  .tile.good .value { color: var(--green); }

  /* ─────────── section ─────────── */
  section.block {
    background: var(--bg);
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    padding: 28px;
    margin-bottom: 24px;
  }
  section.block h2 {
    font-size: 19px; font-weight: 700; letter-spacing: -0.01em;
    margin: 0 0 6px; color: var(--ink);
  }
  section.block p.lead {
    color: var(--ink-muted); font-size: 14px; margin: 0 0 20px;
  }
  .empty {
    color: var(--ink-faint); font-style: italic; font-size: 14px;
    padding: 16px 0;
  }

  /* ─────────── columns layout ─────────── */
  .cols {
    display: grid; gap: 24px;
    grid-template-columns: 1fr;
  }
  @media (min-width: 1024px) {
    .cols { grid-template-columns: 1.7fr 1fr; }
  }

  /* ─────────── task card ─────────── */
  .task {
    display: flex; flex-direction: column;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    transition: border-color 120ms ease;
  }
  .task + .task { margin-top: 12px; }
  .task:hover { border-color: var(--brand); }
  .task .head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; flex-wrap: wrap;
  }
  .task .title {
    font-size: 16px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--ink); flex: 1 1 auto;
  }
  .task .status-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
    white-space: nowrap;
  }
  .status-pill.open { background: var(--brand-soft); color: var(--brand); }
  .status-pill.blocked { background: var(--amber-soft); color: var(--amber); }
  .status-pill.done { background: var(--green-soft); color: var(--green); }
  .status-pill.risk { background: var(--red-soft); color: var(--red); }
  .status-pill.other { background: var(--border-soft); color: var(--slate); }
  .status-pill .dot {
    width: 6px; height: 6px; border-radius: 50%; background: currentColor;
  }

  .task .meta {
    display: flex; flex-wrap: wrap; gap: 14px 24px;
    margin-top: 12px;
    font-size: 13px; color: var(--ink-muted);
  }
  .task .meta .item {
    display: inline-flex; align-items: center; gap: 6px;
  }
  .task .meta .item strong { color: var(--ink); font-weight: 600; }
  .task .meta .overdue-tag {
    color: var(--red); font-weight: 600;
    background: var(--red-soft); padding: 2px 8px; border-radius: 4px;
  }

  .task .progress-row {
    margin-top: 14px;
    display: flex; align-items: center; gap: 12px;
  }
  .task .progress-bar {
    flex: 1; height: 6px; background: var(--border-soft);
    border-radius: 999px; overflow: hidden;
  }
  .task .progress-bar .fill {
    height: 100%; background: linear-gradient(90deg, var(--brand), #4f46e5);
    border-radius: 999px; transition: width 200ms ease;
  }
  .task .progress-bar .fill.blocked { background: var(--amber); }
  .task .progress-bar .fill.done { background: var(--green); }
  .task .progress-pct {
    font-size: 13px; color: var(--ink-muted); font-weight: 600;
    font-variant-numeric: tabular-nums; min-width: 36px; text-align: right;
  }

  .task .last-update {
    margin-top: 14px;
    padding: 12px 14px;
    background: var(--bg-soft);
    border-radius: 8px;
    font-size: 13px; color: var(--ink-muted);
    border-left: 3px solid var(--border);
  }
  .task .last-update .who {
    color: var(--ink-faint); font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .task .last-update .body {
    color: var(--ink); line-height: 1.5;
  }
  .task .blocked-reason {
    margin-top: 12px;
    padding: 10px 14px;
    background: var(--amber-soft);
    border-radius: 8px;
    color: var(--amber);
    font-size: 13px; font-weight: 500;
    border-left: 3px solid var(--amber);
  }

  /* ─────────── workload bars ─────────── */
  .workload-row {
    display: grid; grid-template-columns: 130px 1fr 80px;
    align-items: center; gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .workload-row:last-child { border-bottom: 0; }
  .workload-row .name {
    font-size: 14px; font-weight: 600; color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .workload-row .bar-wrap {
    height: 10px; background: var(--border-soft);
    border-radius: 999px; overflow: hidden;
    display: flex;
  }
  .workload-row .bar {
    height: 100%;
    transition: width 200ms ease;
  }
  .workload-row .bar.open { background: var(--brand); }
  .workload-row .bar.blocked { background: var(--amber); }
  .workload-row .bar.overdue { background: var(--red); }
  .workload-row .count {
    font-size: 13px; color: var(--ink-muted); font-weight: 600;
    font-variant-numeric: tabular-nums; text-align: right;
  }
  .workload-row .count .total { font-weight: 700; color: var(--ink); }
  .workload-row .subnote {
    grid-column: 2 / 4;
    font-size: 11px; color: var(--ink-faint);
    margin-top: 2px;
  }
  .workload-row .heavy-tag {
    display: inline-block;
    margin-left: 8px;
    font-size: 10px; font-weight: 700;
    background: var(--red-soft); color: var(--red);
    padding: 1px 6px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  /* ─────────── activity timeline ─────────── */
  .activity-item {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 16px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border-soft);
    font-size: 13px;
  }
  .activity-item:last-child { border-bottom: 0; }
  .activity-item .when {
    color: var(--ink-faint); font-size: 12px;
    font-variant-numeric: tabular-nums;
    padding-top: 1px;
  }
  .activity-item .content {
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .activity-item .source-tag {
    display: inline-block;
    font-size: 10px; font-weight: 700;
    padding: 1px 6px; border-radius: 3px;
    margin-right: 6px;
    text-transform: uppercase; letter-spacing: 0.04em;
    background: var(--brand-soft); color: var(--brand);
  }
  .activity-item .source-tag.system { background: var(--border-soft); color: var(--slate); }
  .activity-item .source-tag.ai { background: #f5f3ff; color: #7c3aed; }
  .activity-item .activity-task {
    color: var(--ink-muted); font-size: 12px; margin-top: 2px;
  }

  /* ─────────── recently completed ─────────── */
  .done-pills {
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .done-pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--green-soft); color: var(--green);
    padding: 6px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 500;
  }
  .done-pill::before {
    content: "✓"; font-weight: 700;
  }

  /* ─────────── back / expired ─────────── */
  .cta-mini {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--brand); color: #fff;
    padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600;
  }
  .cta-mini:hover { background: var(--brand-hover); color: #fff; }

  .center-shell {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 32px;
    background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  }
  .center-card {
    max-width: 520px; width: 100%;
    background: #fff; border: 1px solid var(--border); border-radius: 16px;
    padding: 48px 40px;
    box-shadow: var(--shadow-card);
    text-align: center;
  }
  .center-card .glyph {
    width: 56px; height: 56px; border-radius: 14px;
    background: var(--amber-soft); color: var(--amber);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 28px; margin-bottom: 20px;
  }
  .center-card h1 {
    font-size: 24px; font-weight: 700; letter-spacing: -0.02em;
    margin: 0 0 12px; color: var(--ink);
  }
  .center-card p { color: var(--ink-muted); font-size: 15px; line-height: 1.6; margin: 10px 0; }
  .center-card .how-to {
    margin-top: 20px; padding: 14px 18px;
    background: var(--bg-soft); border-radius: 10px;
    border: 1px solid var(--border-soft);
    color: var(--ink-muted); font-size: 13px;
  }
</style>
`;

function pickLang(snapshot: DashboardSnapshot, override?: string | null): Lang {
  if (override === 'en' || override === 'zh') return override;
  return detectLanguageFromTexts(snapshot.languageSamples);
}

function formatDeadline(due: Date, now: Date, c: DashCopy): { text: string; isOverdue: boolean } {
  const diffMs = due.getTime() - now.getTime();
  const isOverdue = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const days = Math.floor(absMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((absMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((absMs % (60 * 60 * 1000)) / (60 * 1000));

  let span: string;
  if (days > 0) span = `${days}${c.card.days}${hours > 0 ? ` ${hours}${c.card.hours}` : ''}`;
  else if (hours > 0) span = `${hours}${c.card.hours}`;
  else span = `${Math.max(1, minutes)}${c.card.minutes}`;

  return {
    text: isOverdue ? `${span} ${c.card.ago}` : `${c.card.inFuture} ${span}`,
    isOverdue,
  };
}

function relativeTime(at: Date, now: Date, c: DashCopy): string {
  const diff = Math.max(0, now.getTime() - at.getTime());
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days}${c.card.days} ${c.card.ago}`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours > 0) return `${hours}${c.card.hours} ${c.card.ago}`;
  const minutes = Math.floor(diff / (60 * 1000));
  return `${Math.max(1, minutes)}${c.card.minutes} ${c.card.ago}`;
}

function statusPill(status: TaskStatus, c: DashCopy): string {
  const tone = STATUS_TONE[status];
  return `<span class="status-pill ${tone}"><span class="dot"></span>${escapeHtml(c.status[status])}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTaskCard(task: Task, now: Date, c: DashCopy, viewerTz: string, lang: Lang): string {
  const deadline = formatDeadline(task.time, now, c);
  const dueAbs = formatDateTime(task.time, { tz: viewerTz, locale: lang });
  const tone = STATUS_TONE[task.status];
  const pct = Math.max(0, Math.min(100, task.progressPercent));
  const fillClass = tone === 'blocked' ? 'blocked' : tone === 'done' ? 'done' : '';

  const lastUpdateBlock =
    task.lastProgressSummary && task.lastProgressAt
      ? `
    <div class="last-update">
      <div class="who">${escapeHtml(c.card.lastUpdate)} · ${escapeHtml(relativeTime(task.lastProgressAt, now, c))}</div>
      <div class="body">${escapeHtml(task.lastProgressSummary)}</div>
    </div>`
      : `
    <div class="last-update">
      <div class="body" style="color: var(--ink-faint); font-style: italic;">${escapeHtml(c.card.noUpdates)}</div>
    </div>`;

  const blockedReasonBlock =
    task.status === 'BLOCKED' && task.notCompletedReason
      ? `<div class="blocked-reason"><strong>${escapeHtml(c.card.blockedReason)}:</strong> ${escapeHtml(task.notCompletedReason)}</div>`
      : '';

  return `
  <div class="task">
    <div class="head">
      <div class="title">${escapeHtml(task.title)}</div>
      ${statusPill(task.status, c)}
    </div>
    <div class="meta">
      <div class="item"><strong>${escapeHtml(c.card.assignee)}:</strong> ${escapeHtml(toSlackMention(task.assignee))}</div>
      <div class="item"><strong>${escapeHtml(c.card.due)}:</strong> ${escapeHtml(dueAbs)} <span class="${deadline.isOverdue ? 'overdue-tag' : ''}">${deadline.isOverdue ? escapeHtml(c.card.overdueTag) + ' · ' : ''}${escapeHtml(deadline.text)}</span></div>
    </div>
    <div class="progress-row">
      <div class="progress-bar"><div class="fill ${fillClass}" style="width: ${pct}%"></div></div>
      <div class="progress-pct">${pct}%</div>
    </div>
    ${blockedReasonBlock}
    ${lastUpdateBlock}
  </div>`;
}

function renderWorkloadBars(snapshot: DashboardSnapshot, c: DashCopy): string {
  if (snapshot.workload.length === 0) {
    return `<div class="empty">${escapeHtml(c.sections.empty)}</div>`;
  }

  // Scale: longest bar = the max total across all entries.
  const maxTotal = Math.max(...snapshot.workload.map((w) => w.total), 1);

  // "Heavy load" tag = top entry IF it carries 5+ tasks OR is meaningfully ahead.
  const heaviest = snapshot.workload[0];
  const isHeavy =
    heaviest &&
    heaviest.total >= 5 &&
    (snapshot.workload.length === 1 || heaviest.total >= (snapshot.workload[1]?.total ?? 0) + 2);

  return snapshot.workload
    .map((w) => {
      const totalPct = (w.total / maxTotal) * 100;
      const blockedPct = w.total > 0 ? (w.blocked / w.total) * totalPct : 0;
      const overduePct = w.total > 0 ? (w.overdue / w.total) * totalPct : 0;
      const openPct = totalPct - blockedPct - overduePct;
      const heavyBadge =
        isHeavy && w === heaviest
          ? `<span class="heavy-tag">${escapeHtml(c.workload.loadTag)}</span>`
          : '';
      const extras: string[] = [];
      if (w.blocked) extras.push(`${w.blocked} ${c.workload.blockedSuffix}`);
      if (w.overdue) extras.push(`${w.overdue} ${c.workload.overdueSuffix}`);
      const subnote = extras.length
        ? `<div class="subnote">${escapeHtml(extras.join(' · '))}</div>`
        : '';

      return `
    <div class="workload-row">
      <div class="name">${escapeHtml(toSlackMention(w.assigneeId))}${heavyBadge}</div>
      <div class="bar-wrap">
        <div class="bar open" style="width: ${openPct}%"></div>
        <div class="bar blocked" style="width: ${blockedPct}%"></div>
        <div class="bar overdue" style="width: ${overduePct}%"></div>
      </div>
      <div class="count"><span class="total">${w.total}</span> ${escapeHtml(c.workload.tasksWord)}</div>
      ${subnote}
    </div>`;
    })
    .join('');
}

function renderActivity(snapshot: DashboardSnapshot, now: Date, c: DashCopy): string {
  if (snapshot.activity.length === 0) {
    return `<div class="empty">${escapeHtml(c.sections.empty)}</div>`;
  }
  return snapshot.activity
    .map((e) => {
      const tag =
        e.source === 'employee_reply'
          ? { label: c.activity.sourceEmployee, cls: '' }
          : e.source === 'system'
            ? { label: c.activity.sourceSystem, cls: 'system' }
            : e.source === 'ai_summary'
              ? { label: c.activity.sourceAi, cls: 'ai' }
              : e.source === 'manual_owner'
                ? { label: c.activity.sourceOwner, cls: 'system' }
                : { label: e.source, cls: 'system' };
      return `
    <div class="activity-item">
      <div class="when">${escapeHtml(relativeTime(e.at, now, c))}</div>
      <div class="content">
        <span class="source-tag ${tag.cls}">${escapeHtml(tag.label)}</span>
        ${escapeHtml(e.summary)}
        <div class="activity-task">${escapeHtml(e.taskTitle)}</div>
      </div>
    </div>`;
    })
    .join('');
}

export function renderDashboard(args: {
  snapshot: DashboardSnapshot;
  langOverride?: string | null;
  slackDeepLink: string;
  /** IANA tz of the viewer. Used to format all deadlines so they read in local time. */
  viewerTz?: string | null;
}): string {
  const lang = pickLang(args.snapshot, args.langOverride);
  const c = COPY[lang];
  const now = new Date();
  const s = args.snapshot;
  const viewerTz = args.viewerTz || process.env.DEFAULT_TIMEZONE || 'America/New_York';

  const otherLangUrl = `?token={KEEP}&lang=${lang === 'en' ? 'zh' : 'en'}`;

  // The token isn't re-emitted in the lang switcher — we pass the literal
  // string {KEEP} and substitute the current URL's token below at render.
  // Avoids leaking the token into the document body twice unnecessarily.
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(c.meta.title)}</title>
  <meta name="robots" content="noindex, nofollow" />
  ${STYLES}
</head>
<body>

  <nav class="top">
    <div class="brand-mark">
      <span class="brand-dot"></span>
      <span>Aiptima</span>
    </div>
    <div class="nav-right">
      <div class="lang-switch">
        <a class="${lang === 'en' ? 'active' : ''}" href="${LANG_SWITCH_PLACEHOLDER}en">EN</a>
        <span class="sep">·</span>
        <a class="${lang === 'zh' ? 'active' : ''}" href="${LANG_SWITCH_PLACEHOLDER}zh">中</a>
      </div>
      <a class="cta-mini" href="${escapeHtml(args.slackDeepLink)}">${escapeHtml(c.nav.back)}</a>
    </div>
  </nav>

  <div class="shell">

    <header class="hero">
      <h1>${escapeHtml(c.hero.greeting)}</h1>
      <p>${escapeHtml(c.hero.sub)}</p>
    </header>

    <div class="tiles">
      <div class="tile"><div class="label">${escapeHtml(c.tiles.open)}</div><div class="value">${s.summary.open}</div></div>
      <div class="tile ${s.summary.blocked > 0 ? 'warn' : ''}"><div class="label">${escapeHtml(c.tiles.blocked)}</div><div class="value">${s.summary.blocked}</div></div>
      <div class="tile ${s.summary.overdue > 0 ? 'alert' : ''}"><div class="label">${escapeHtml(c.tiles.overdue)}</div><div class="value">${s.summary.overdue}</div></div>
      <div class="tile good"><div class="label">${escapeHtml(c.tiles.doneThisWeek)}</div><div class="value">${s.summary.completedThisWeek}</div></div>
    </div>

    ${
      s.riskTasks.length > 0
        ? `
    <section class="block">
      <h2>${escapeHtml(c.sections.risks)}</h2>
      <p class="lead">${escapeHtml(c.sections.risksLead)}</p>
      ${s.riskTasks.map((t) => renderTaskCard(t, now, c, viewerTz, lang)).join('')}
    </section>`
        : ''
    }

    <div class="cols">
      <div>
        <section class="block">
          <h2>${escapeHtml(c.sections.active)}</h2>
          <p class="lead">${escapeHtml(c.sections.activeLead)}</p>
          ${
            s.activeTasks.length === 0
              ? `<div class="empty">${escapeHtml(c.sections.empty)}</div>`
              : s.activeTasks.map((t) => renderTaskCard(t, now, c, viewerTz, lang)).join('')
          }
        </section>

        ${
          s.recentlyCompleted.length > 0
            ? `
        <section class="block">
          <h2>${escapeHtml(c.sections.completed)}</h2>
          <div class="done-pills">
            ${s.recentlyCompleted.map((t) => `<div class="done-pill">${escapeHtml(t.title)}</div>`).join('')}
          </div>
        </section>`
            : ''
        }
      </div>

      <div>
        <section class="block">
          <h2>${escapeHtml(c.sections.workload)}</h2>
          <p class="lead">${escapeHtml(c.sections.workloadLead)}</p>
          ${renderWorkloadBars(s, c)}
        </section>

        <section class="block">
          <h2>${escapeHtml(c.sections.activity)}</h2>
          <p class="lead">${escapeHtml(c.sections.activityLead)}</p>
          ${renderActivity(s, now, c)}
        </section>
      </div>
    </div>

  </div>

</body></html>`;
}

/**
 * Placeholder substituted at request time so lang switcher links carry the
 * current token across without us re-encoding it in this template module.
 * The route handler swaps `${LANG_SWITCH_PLACEHOLDER}en` for the real URL.
 */
export const LANG_SWITCH_PLACEHOLDER = '__DASH_LANG__';

/**
 * Page shown when a token is missing, malformed, expired, or signature-mismatched.
 * Same look as the rest so it doesn't feel like a Web 1.0 error screen.
 */
export function renderExpiredOrInvalid(lang: Lang = 'en'): string {
  const c = COPY[lang];
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(c.meta.title)}</title>
  <meta name="robots" content="noindex, nofollow" />
  ${STYLES}
</head>
<body>
  <div class="center-shell">
    <div class="center-card">
      <div class="glyph">!</div>
      <h1>${escapeHtml(c.expired.title)}</h1>
      <p>${escapeHtml(c.expired.body)}</p>
      <div class="how-to">${escapeHtml(c.expired.howTo)}</div>
    </div>
  </div>
</body></html>`;
}
