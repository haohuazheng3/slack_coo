import { TaskStatus, TaskPriority } from '@prisma/client';

export type SupportedLanguage = 'en' | 'zh';

function pickLanguage(value?: string | null): SupportedLanguage {
  if (!value) return 'en';
  const lc = value.toLowerCase();
  if (lc.startsWith('zh') || lc === 'chinese' || lc === '中文') return 'zh';
  return 'en';
}

// CJK Unified Ideographs ranges (covers Chinese, Japanese kanji). We don't try to
// distinguish further than zh-vs-not — the SupportedLanguage union is zh|en today;
// add more as the UI grows.
const CJK_RANGE = /[一-鿿㐀-䶿]/;

/**
 * Pick a language from a handful of natural-language samples — task titles, recent
 * progress summaries, anything that reflects how the workspace actually talks.
 * The product has no configured language; this is how we figure it out at render time.
 */
export function detectLanguageFromTexts(texts: Array<string | null | undefined>): SupportedLanguage {
  let cjk = 0;
  let latin = 0;
  for (const raw of texts) {
    if (!raw) continue;
    for (const ch of raw) {
      if (CJK_RANGE.test(ch)) cjk++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  // Tilt toward zh once CJK characters dominate. A few stray English words in a
  // mostly-Chinese workspace shouldn't flip the result.
  if (cjk > 0 && cjk >= latin * 0.5) return 'zh';
  return 'en';
}

const STATUS_LABEL: Record<SupportedLanguage, Record<TaskStatus, string>> = {
  en: {
    PENDING_CLARIFICATION: 'Awaiting clarification',
    NOT_STARTED: 'Not started',
    IN_PROGRESS: 'In progress',
    BLOCKED: 'Blocked',
    COMPLETED: 'Completed',
    FAILED: 'Not completed',
    CANCELLED: 'Cancelled',
  },
  zh: {
    PENDING_CLARIFICATION: '等待澄清',
    NOT_STARTED: '未开始',
    IN_PROGRESS: '进行中',
    BLOCKED: '受阻',
    COMPLETED: '已完成',
    FAILED: '未完成',
    CANCELLED: '已取消',
  },
};

const STATUS_ICON: Record<TaskStatus, string> = {
  PENDING_CLARIFICATION: '❓',
  NOT_STARTED: '🕒',
  IN_PROGRESS: '🚧',
  BLOCKED: '⛔',
  COMPLETED: '✅',
  FAILED: '❌',
  CANCELLED: '🚫',
};

const PRIORITY_BADGE: Record<SupportedLanguage, Record<TaskPriority, string>> = {
  en: {
    LOW: '🟢 LOW',
    NORMAL: '🟡 NORMAL',
    HIGH: '🟠 HIGH',
    URGENT: '🔴 URGENT',
  },
  zh: {
    LOW: '🟢 低',
    NORMAL: '🟡 普通',
    HIGH: '🟠 高',
    URGENT: '🔴 紧急',
  },
};

type CommonKey =
  | 'home.title'
  | 'home.hint'
  | 'home.openInBrowser'
  | 'home.openInBrowserHint'
  | 'home.summary.needInput'
  | 'home.summary.inFlight'
  | 'home.summary.blocked'
  | 'home.summary.overdue'
  | 'home.summary.done'
  | 'home.summary.clean'
  | 'home.group.needsInput'
  | 'home.group.inFlight'
  | 'home.group.blocked'
  | 'home.group.overdue'
  | 'home.group.completed'
  | 'home.group.other'
  | 'home.empty'
  | 'card.due'
  | 'card.assignee'
  | 'card.from'
  | 'card.progress'
  | 'card.noUpdates'
  | 'card.overdueTag'
  | 'card.reason'
  | 'card.btn.complete'
  | 'card.btn.modify'
  | 'card.btn.delete'
  | 'list.headerPending'
  | 'list.headerCompleted'
  | 'list.empty'
  | 'list.emptyAll'
  | 'list.emptyCompleted'
  | 'list.summary'
  | 'time.justNow'
  | 'time.minutesAgo'
  | 'time.hoursAgo'
  | 'time.daysAgo'
  | 'onboarding.title'
  | 'onboarding.body'
  | 'onboarding.example1'
  | 'onboarding.example2'
  | 'onboarding.example3'
  | 'onboarding.footer';

const COMMON: Record<SupportedLanguage, Record<CommonKey, string>> = {
  en: {
    'home.title': '📊 Aiptima — Operations Dashboard',
    'home.hint':
      '_Just DM me or @-mention me in a channel. Talk to me like a teammate — I\'ll figure out the structure, follow up with the team, and surface what you need to see._',
    'home.openInBrowser': '🌐 Open full dashboard',
    'home.openInBrowserHint':
      '_Workload heatmap, risk feed, full activity timeline — too much for Slack to render, so we built it as a web view._',
    'home.summary.needInput': '{n} need input',
    'home.summary.inFlight': '{n} in flight',
    'home.summary.blocked': '{n} blocked',
    'home.summary.overdue': '{n} overdue',
    'home.summary.done': '{n} done',
    'home.summary.clean': '_Everything is clear._',
    'home.group.needsInput': '❓ Needs your input',
    'home.group.inFlight': '🚧 In flight',
    'home.group.blocked': '⛔ Blocked',
    'home.group.overdue': '⚠️ Overdue',
    'home.group.completed': '✅ Completed (recent)',
    'home.group.other': '🗂 Other (cancelled / failed)',
    'home.empty':
      '🎉 _Nothing on the board yet. DM me or @-mention me anywhere — e.g._ `@Aiptima ask Luna to finalize the Q4 deck by Friday EOD.`',
    'card.due': 'Due',
    'card.assignee': 'Assignee',
    'card.from': 'From',
    'card.progress': 'Progress',
    'card.noUpdates': '_No updates yet._',
    'card.overdueTag': '⚠️ overdue',
    'card.reason': 'Reason',
    'card.btn.complete': '✅ Mark complete',
    'card.btn.modify': '✏️ Modify',
    'card.btn.delete': '🗑️ Delete',
    'list.headerPending': '📋 Your Tasks',
    'list.headerCompleted': '✅ Completed Tasks',
    'list.empty': '📋 You have no pending tasks!',
    'list.emptyAll': '📋 You have no tasks!',
    'list.emptyCompleted': '📋 You have no completed tasks!',
    'list.summary': 'You have {n} tasks',
    'time.justNow': 'just now',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.daysAgo': '{n}d ago',
    'onboarding.title': '👋 Welcome — here\'s the whole onboarding',
    'onboarding.body':
      'Just talk to me. DM me directly, or @-mention me in any channel. No forms, no roster to enroll, no project-management software to learn. I\'ll figure out the structure (who, what, when) and follow up with the team on your behalf.',
    'onboarding.example1':
      '• `@Aiptima have Lisa do the launch banner this week` — I\'ll find Lisa, pick a default deadline, and DM her with context.',
    'onboarding.example2':
      '• `ask the design team for a new logo, urgent` — I\'ll ask which designer if I\'m not sure, and remember the answer.',
    'onboarding.example3':
      '• `how\'s the Q4 deck going?` — I\'ll check, summarize the reply for you, and surface silence as a fact (never as a verdict).',
    'onboarding.footer':
      'I never characterize people\'s performance — I just show you the facts and hand the call back to you. The team only ever hears from me in DM.',
  },
  zh: {
    'home.title': '📊 Aiptima — 任务运营看板',
    'home.hint':
      '_直接 DM 我或在任意频道 @ 我。说人话就行——我来拆任务、跟员工对齐、把进度（包括沉默）按你想看到的方式呈现。_',
    'home.openInBrowser': '🌐 打开完整看板',
    'home.openInBrowserHint':
      '_工作量热图、风险任务区、完整动态时间线——Slack 装不下,我们做了一个网页版。_',
    'home.summary.needInput': '{n} 项待补充',
    'home.summary.inFlight': '{n} 项进行中',
    'home.summary.blocked': '{n} 项受阻',
    'home.summary.overdue': '{n} 项逾期',
    'home.summary.done': '{n} 项已完成',
    'home.summary.clean': '_当前没有需要关注的任务。_',
    'home.group.needsInput': '❓ 需要您补充信息',
    'home.group.inFlight': '🚧 进行中',
    'home.group.blocked': '⛔ 受阻',
    'home.group.overdue': '⚠️ 已逾期',
    'home.group.completed': '✅ 最近完成',
    'home.group.other': '🗂 其他（已取消 / 未完成）',
    'home.empty':
      '🎉 _暂无任务。直接 DM 我或在频道 @ 我，例如：_ `@Aiptima 让 Luna 在周五下班前完成 Q4 方案`',
    'card.due': '截止',
    'card.assignee': '负责人',
    'card.from': '发起人',
    'card.progress': '进度',
    'card.noUpdates': '_暂无更新。_',
    'card.overdueTag': '⚠️ 已逾期',
    'card.reason': '原因',
    'card.btn.complete': '✅ 标记完成',
    'card.btn.modify': '✏️ 修改',
    'card.btn.delete': '🗑️ 删除',
    'list.headerPending': '📋 你的任务',
    'list.headerCompleted': '✅ 已完成任务',
    'list.empty': '📋 当前没有待办任务。',
    'list.emptyAll': '📋 当前没有任务。',
    'list.emptyCompleted': '📋 暂无已完成任务。',
    'list.summary': '共 {n} 条任务',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.daysAgo': '{n} 天前',
    'onboarding.title': '👋 欢迎 — 这就是全部的 onboarding',
    'onboarding.body':
      '直接跟我说话就行。在 DM 里找我，或在任意频道 @ 我。不用填表、不用录花名册、不用学项目管理软件。我会自己拆任务（谁、什么、什么时候），并替你去跟员工对齐。',
    'onboarding.example1':
      '• `@Aiptima 让 Lisa 这周出个发布 banner` — 我会找到 Lisa、默认一个截止时间，并把背景同步给她。',
    'onboarding.example2':
      '• `让设计那边出个新 logo，紧急` — 不确定是哪位的话我会问一次，并把答案记下来下次不再问。',
    'onboarding.example3':
      '• `Q4 方案进展怎样了？` — 我去问、把回复翻译成你看得懂的版本，并把"沉默"作为事实呈现（不下任何判断）。',
    'onboarding.footer':
      '我从不评判员工是"快"还是"慢"——只把事实摆出来，决定权留给你。对员工只走 DM，不在大群公开。',
  },
};

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
}

export type Translator = {
  language: SupportedLanguage;
  t: (key: CommonKey, params?: Record<string, string | number>) => string;
  statusLabel: (status: TaskStatus) => string;
  statusIcon: (status: TaskStatus) => string;
  priorityBadge: (priority: TaskPriority) => string;
  relativeTime: (at: Date | null | undefined) => string;
};

export function getTranslator(language?: SupportedLanguage | string | null): Translator {
  // Fallback to 'en' when no signal exists. Callers that have task content in
  // hand should pass it through detectLanguageFromTexts() and call this with
  // the detected language instead of relying on the fallback.
  const lang: SupportedLanguage =
    typeof language === 'string' ? pickLanguage(language) : (language as SupportedLanguage | undefined) ?? 'en';
  const common = COMMON[lang];
  const status = STATUS_LABEL[lang];
  const priority = PRIORITY_BADGE[lang];

  return {
    language: lang,
    t: (key, params) => format(common[key], params),
    statusLabel: (s) => status[s] ?? s,
    statusIcon: (s) => STATUS_ICON[s] ?? '•',
    priorityBadge: (p) => priority[p] ?? '',
    relativeTime: (at) => relativeTime(at, lang),
  };
}

function relativeTime(at: Date | null | undefined, lang: SupportedLanguage): string {
  if (!at) return '—';
  const ms = Date.now() - at.getTime();
  const common = COMMON[lang];
  if (ms < 60_000) return common['time.justNow'];
  if (ms < 3_600_000) return format(common['time.minutesAgo'], { n: Math.round(ms / 60_000) });
  if (ms < 86_400_000) return format(common['time.hoursAgo'], { n: Math.round(ms / 3_600_000) });
  return format(common['time.daysAgo'], { n: Math.round(ms / 86_400_000) });
}

export const defaultTranslator = getTranslator();
