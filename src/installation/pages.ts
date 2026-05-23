import type { Response, Request } from 'express';

export type Lang = 'en' | 'zh';

/**
 * Read the user's preferred landing-page language off the request.
 * Default = English; switching is opt-in via `?lang=zh`.
 */
export function readLangFromRequest(req: Request): Lang {
  const raw = (req.query?.lang ?? '').toString().toLowerCase();
  return raw === 'zh' ? 'zh' : 'en';
}

/**
 * Content map for the install-flow pages. Both languages live in one object so
 * the templating below stays simple and translators (or future you) only have
 * to edit one place.
 *
 * Mockup conversation is also language-aware — it would feel jarring to read
 * an English landing page and see Chinese Slack bubbles or vice versa.
 */
type Copy = {
  meta: { title: string; description: string };
  nav: { addToSlack: string };
  switcher: { en: string; zh: string; ariaSwitchTo: string };
  hero: {
    eyebrow: string;
    titleLine1: string;
    titleAccent: string;
    sub: string;
    cta: string;
    meta: string;
  };
  workflow: {
    eyebrow: string;
    title: string;
    lead: string;
    steps: Array<{ n: string; title: string; body: string }>;
  };
  mockup: {
    channel: string;
    dmLabel: string;
    syncLabel: string;
    owner: { initial: string; name: string; t1: string; text1: string };
    bot1: {
      name: string;
      t1: string;
      lead: string;
      line1Title: string;
      line1Meta: string;
      line2Title: string;
      line2Meta: string;
      note: string;
    };
    dmBot: { t1: string; text: string };
    lisa: { initial: string; name: string; t1: string; text: string };
    syncBot: { t1: string; text: string };
  };
  principles: {
    eyebrow: string;
    title: string;
    lead: string;
    cards: Array<{ glyph: string; title: string; body: string }>;
  };
  finalCta: { title: string; sub: string; cta: string };
  footer: { powered: string };
  success: {
    title: string;
    titleHead: string;
    body: string;
    nextSteps: string;
    step1: string;
    step2: string;
    example: string;
    step3: string;
    step4: string;
  };
  failure: { title: string; titleHead: string; retry: string };
};

const COPY: Record<Lang, Copy> = {
  en: {
    meta: {
      title: 'Aiptima — your execution layer, hidden inside Slack',
      description:
        "You talk normally. Aiptima turns it into tracked work, talks to your team on your behalf, and surfaces progress (including silence) the way you'd want to see it.",
    },
    nav: { addToSlack: 'Add to Slack' },
    switcher: { en: 'EN', zh: '中', ariaSwitchTo: 'Switch to' },
    hero: {
      eyebrow: 'For founders running Slack-first teams · Powered by Claude Opus 4.7',
      titleLine1: 'You talk normally.',
      titleAccent: 'Aiptima holds it together.',
      sub: "Inside Slack. Drop one casual sentence — it turns intent into tracked work, talks to your team on your behalf, and surfaces progress (including silence) the way you'd want to see it. Never grades anyone. Only states facts.",
      cta: 'Add to Slack',
      meta: 'No roster to enroll · No team training · 60-second install',
    },
    workflow: {
      eyebrow: 'How it works',
      title: 'Drop one sentence. It handles the rest.',
      lead: 'Aiptima sits inside Slack like a quiet chief of staff — reads your intent, turns it into structured work, talks privately with the team, and translates progress and risk into language you can scan in one second.',
      steps: [
        {
          n: '01',
          title: 'You drop a sentence',
          body: "No ticket form, no @ tag required. Say it in a channel or DM — it figures out who, what, and by when, then creates the task with a sensible default deadline.",
        },
        {
          n: '02',
          title: 'It aligns with the team',
          body: "Aiptima DMs the assignee — always private, never public pressure. Asks how it's going in their native language, and shields them from your repeated follow-ups.",
        },
        {
          n: '03',
          title: 'It translates back to you',
          body: "The employee's casual “still tweaking colors” becomes the headline you care about: “on track to ship, risk point X.” Long silence? Reported as a fact — you decide what to do.",
        },
      ],
    },
    mockup: {
      channel: 'leadership',
      dmLabel: 'DM with Lisa',
      syncLabel: 'Synced to owner',
      owner: {
        initial: 'W',
        name: 'Wang',
        t1: '10:42',
        text1: 'Have Lisa do the launch banner by Friday. Mike’s landing page ships Tuesday.',
      },
      bot1: {
        name: 'Aiptima',
        t1: '10:42',
        lead: 'Got it. Two tasks set up \u{1F447}',
        line1Title: 'Launch banner',
        line1Meta: '@Lisa · Friday 6:00 PM',
        line2Title: 'Landing page ships',
        line2Meta: '@Mike · Next Tuesday 6:00 PM',
        note: 'Mike is waiting on the banner, so I sequenced them. Change anything if I got it wrong.',
      },
      dmBot: {
        t1: '10:43',
        text: "Hi Lisa — Wang asked you to do the launch banner, due Friday 6 PM. Mike needs it before he can ship the landing page. A one-liner is plenty — I'll handle the rest with Wang.",
      },
      lisa: {
        initial: 'L',
        name: 'Lisa',
        t1: '14:18',
        text: 'Drafted two versions, finalizing color now — should lock by tomorrow AM.',
      },
      syncBot: {
        t1: '14:18',
        text: 'Banner (Lisa): 2 drafts done, locking tomorrow AM. On track for Friday.',
      },
    },
    principles: {
      eyebrow: 'The rules',
      title: 'Facts go everywhere. Judgment stays with you.',
      lead: "This is Aiptima's soul. It never grades whether an employee is fast or slow — it just states the facts and hands the call back to you.",
      cards: [
        {
          glyph: 'F',
          title: 'Facts only, no verdicts',
          body: "“No reply for 1 day” — fine. “Probably slacking” — never. The moment AI grades your team, your data source starts faking.",
        },
        {
          glyph: 'P',
          title: 'Pressure privately, never publicly',
          body: 'All follow-ups, status questions, silence notices — DM only. Never calls anyone out in a group. Never makes anyone lose face.',
        },
        {
          glyph: 'S',
          title: 'Silence is a signal — but a scalpel',
          body: "We tell you when someone hasn't replied — but only when the silence actually matters. Not a notification firehose.",
        },
      ],
    },
    finalCta: {
      title: '60 seconds to install. Hours a week off your plate.',
      sub: 'Hand the owner-team information gap to a quiet chief of staff — always on, never grading, speaking each person’s own language.',
      cta: 'Add to Slack',
    },
    footer: { powered: 'Powered by Claude Opus 4.7' },
    success: {
      title: 'You’re all set · Aiptima',
      titleHead: 'You’re all set.',
      body: 'Aiptima is installed in your Slack workspace.',
      nextSteps: 'Next steps',
      step1: 'Open Slack and find <strong>Aiptima</strong> in your DMs, or <strong>@</strong>-mention it in any channel.',
      step2: 'Just talk to it normally, for example:',
      example: '@Aiptima have Luna ship the Q4 deck by Friday EOD',
      step3: 'Use <strong>/invite</strong> to add it to any channel where you want it listening in the background.',
      step4: 'Open the <strong>App Home</strong> tab in Slack — that’s your dashboard.',
    },
    failure: {
      title: 'Install didn’t complete · Aiptima',
      titleHead: 'Install didn’t complete',
      retry: 'Try the install link again, or send us this error message.',
    },
  },

  zh: {
    meta: {
      title: 'Aiptima — 你的执行枢纽,藏在 Slack 里',
      description:
        '老板说人话,Aiptima 把口语变成跟踪任务、在你和团队之间做传译、把进度(包括沉默)按你想看的方式呈现。',
    },
    nav: { addToSlack: '添加到 Slack' },
    switcher: { en: 'EN', zh: '中', ariaSwitchTo: '切换至' },
    hero: {
      eyebrow: '现已基于 Claude Opus 4.7',
      titleLine1: '老板随口一句,',
      titleAccent: 'Aiptima 把事兜住。',
      sub: '在 Slack 里。你随手甩一句话,它替你拆任务、跟员工对齐、把进度(包括沉默)按你想看的方式呈现。不评判任何人,只把事实摆出来。',
      cta: '添加到 Slack',
      meta: '无需录花名册 · 无需培训员工 · 60 秒装好',
    },
    workflow: {
      eyebrow: '看一眼工作流',
      title: '一句话甩进去,后面的事它替你办。',
      lead: 'Aiptima 在 Slack 里像一位安静的参谋——读懂你的口语意图、转成结构化任务、私下跟员工对齐、把进度和风险翻译成你能 1 秒扫完的语言。',
      steps: [
        {
          n: '01',
          title: '你甩话',
          body: '不用写工单,不用 @ 谁。在频道里说人话或者 DM 私下说,它都会理解"谁、什么、什么时候",并自动建好任务、设好默认 deadline。',
        },
        {
          n: '02',
          title: '它跟员工对齐',
          body: 'Aiptima 私聊任务负责人——永远 DM,从不公开施压。用员工的母语问"咋样了",并替他挡掉老板的反复追问。',
        },
        {
          n: '03',
          title: '它给你翻译回来',
          body: '员工随口的"在调色"被翻译成你关心的"按期没问题、风险点 X"。长时间不回?事实呈现给你,要不要追问由你决定。',
        },
      ],
    },
    mockup: {
      channel: 'leadership',
      dmLabel: '与 Lisa 私聊',
      syncLabel: '同步给老板',
      owner: {
        initial: 'W',
        name: 'Wang',
        t1: '10:42',
        text1: '让 Lisa 把发布页 banner 周五前出来,小王那边发布页周二上线。',
      },
      bot1: {
        name: 'Aiptima',
        t1: '10:42',
        lead: '收到。建好两件事 \u{1F447}',
        line1Title: '发布页 banner',
        line1Meta: '@Lisa · 本周五 18:00',
        line2Title: '发布页上线',
        line2Meta: '@小王 · 下周二 18:00',
        note: '小王要等 banner,所以我把顺序排好了。改 deadline 直接告诉我。',
      },
      dmBot: {
        t1: '10:43',
        text: 'Hi Lisa,Wang 派了个 banner 给你,周五 18:00 截止。小王在等你出图才能继续。一两句话告诉我进展就行,我来跟老板对接。',
      },
      lisa: {
        initial: 'L',
        name: 'Lisa',
        t1: '14:18',
        text: '出了两版草稿,在调色,明早能定。',
      },
      syncBot: {
        t1: '14:18',
        text: 'banner(Lisa)有进展:2 版草稿,明早定稿。按期没问题。',
      },
    },
    principles: {
      eyebrow: '产品原则',
      title: '事实可以说尽,判断一律留白。',
      lead: '这是 Aiptima 的灵魂。它从不替你判断员工"快"或"慢"——只把事实摆出来,把判断和决定权留给你。',
      cards: [
        {
          glyph: '事',
          title: '只呈现事实,不下判断',
          body: '"已 1 天未回复"可以说;"他可能在摸鱼"一个字不加。AI 一旦评判员工,数据源就开始失真。',
        },
        {
          glyph: '私',
          title: '私下沟通,不公开施压',
          body: '所有催办、状态询问、沉默上报,只走 DM。从不在群里点名,从不当众让任何人难堪。',
        },
        {
          glyph: '默',
          title: '沉默也是信号,但是手术刀',
          body: '长时间不回我们会原样告诉你——但只在真的有信息价值时,不会拿"无回复"轰炸你的通知栏。',
        },
      ],
    },
    finalCta: {
      title: '装好 60 秒,管事少 60 分钟。',
      sub: '把企业主和员工之间那层信息差,交给一个永远在线、从不评判、说员工母语的参谋。',
      cta: '添加到 Slack',
    },
    footer: { powered: 'Powered by Claude Opus 4.7' },
    success: {
      title: '装好了 · Aiptima',
      titleHead: '装好了。',
      body: 'Aiptima 已加入你的 Slack workspace。',
      nextSteps: '下一步',
      step1: '打开 Slack,在 DM 里找 <strong>Aiptima</strong>,或在任意频道 <strong>@</strong> 它',
      step2: '说一句普通话就行,例如:',
      example: '@Aiptima 让 Luna 周五下班前完成 Q4 方案',
      step3: '把它 <strong>/invite</strong> 进你希望它"听背景"的频道',
      step4: '打开 Slack 顶部 <strong>App Home</strong>(Aiptima 的 Home 标签),那是你的看板',
    },
    failure: {
      title: '安装未完成 · Aiptima',
      titleHead: '安装没走完',
      retry: '你可以再点一次安装链接重试,或者把这条错误信息发给我们。',
    },
  },
};

/**
 * The shared stylesheet for every install-flow page. Inline because we don't ship
 * any static-asset pipeline and we want the landing/success/failure pages to be
 * one-shot HTML that renders fast and identically everywhere — no Google Fonts
 * round trip, no external CSS, no JS framework.
 *
 * Design notes (for the next person who touches this):
 * - Light background, blue accent, system-font sans-serif. Stripe-ish but tighter.
 * - The headline color is a single brand blue (#2563EB). The CTA uses the same.
 * - Generous whitespace; no decorative noise.
 * - Slack mockup is real HTML/CSS — no PNG, no canvas. Scales for free.
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
    --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 32px rgba(15, 23, 42, 0.06);
    --shadow-cta: 0 1px 2px rgba(37, 99, 235, 0.12), 0 8px 20px rgba(37, 99, 235, 0.22);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI",
                 system-ui, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    background: var(--bg);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  a { color: var(--brand); text-decoration: none; }
  a:hover { color: var(--brand-hover); }

  /* ─────────── nav ─────────── */
  nav.top {
    display: flex; align-items: center; justify-content: space-between;
    padding: 22px 32px;
    max-width: 1180px; margin: 0 auto;
  }
  .brand-mark {
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 700; font-size: 17px; color: var(--ink); letter-spacing: -0.01em;
  }
  .brand-dot {
    width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--brand) 0%, #4f46e5 100%);
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.4);
  }
  .nav-right {
    display: inline-flex; align-items: center; gap: 18px;
  }
  .lang-switch {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 13px; color: var(--ink-faint); font-weight: 500;
    user-select: none;
  }
  .lang-switch a {
    padding: 4px 8px; border-radius: 6px;
    color: var(--ink-faint); transition: color 120ms ease, background 120ms ease;
  }
  .lang-switch a:hover { color: var(--ink); background: var(--border-soft); }
  .lang-switch a.active {
    color: var(--brand); background: var(--brand-soft); font-weight: 600;
  }
  .lang-switch .sep { color: var(--ink-faint); opacity: 0.5; }
  nav.top .cta-mini {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--brand); color: #fff;
    padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600;
    transition: background 120ms ease, transform 80ms ease;
  }
  nav.top .cta-mini:hover { background: var(--brand-hover); color: #fff; }
  nav.top .cta-mini:active { transform: translateY(1px); }

  /* ─────────── hero ─────────── */
  .hero {
    position: relative;
    max-width: 1180px; margin: 0 auto;
    padding: 80px 32px 100px;
    text-align: center;
    overflow: hidden;
  }
  .hero::before {
    content: "";
    position: absolute; top: -200px; left: 50%; transform: translateX(-50%);
    width: 900px; height: 600px;
    background: radial-gradient(ellipse at center,
                rgba(37, 99, 235, 0.10) 0%,
                rgba(79, 70, 229, 0.06) 35%,
                transparent 70%);
    z-index: -1; pointer-events: none;
  }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--brand); font-size: 13px; font-weight: 600;
    background: var(--brand-soft); padding: 6px 14px; border-radius: 999px;
    margin-bottom: 24px; letter-spacing: 0.02em;
  }
  .eyebrow .pulse {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--brand);
    box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.5);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.5); }
    70% { box-shadow: 0 0 0 8px rgba(37, 99, 235, 0); }
    100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
  }
  h1.hero-title {
    font-size: clamp(40px, 6vw, 64px);
    font-weight: 800; letter-spacing: -0.03em; line-height: 1.05;
    margin: 0 auto 24px; max-width: 820px;
    color: var(--ink);
  }
  h1.hero-title .accent { color: var(--brand); }
  .hero-sub {
    font-size: clamp(17px, 1.4vw, 20px); color: var(--ink-muted);
    max-width: 620px; margin: 0 auto 40px; line-height: 1.55;
  }
  .cta-row { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .cta-primary {
    display: inline-flex; align-items: center; gap: 10px;
    background: var(--brand); color: #fff;
    padding: 14px 28px; border-radius: 10px;
    font-size: 15px; font-weight: 600;
    box-shadow: var(--shadow-cta);
    transition: background 120ms ease, transform 80ms ease, box-shadow 120ms ease;
  }
  .cta-primary:hover { background: var(--brand-hover); color: #fff; transform: translateY(-1px); }
  .cta-primary:active { transform: translateY(0); }
  .cta-primary svg { width: 18px; height: 18px; }
  .cta-meta {
    font-size: 13px; color: var(--ink-faint);
    margin-top: 18px;
  }
  .cta-meta strong { color: var(--ink-muted); font-weight: 500; }

  /* ─────────── section base ─────────── */
  section.block {
    max-width: 1180px; margin: 0 auto;
    padding: 80px 32px;
    border-top: 1px solid var(--border-soft);
  }
  .section-eyebrow {
    color: var(--brand); font-size: 13px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    margin-bottom: 14px;
  }
  h2.section-title {
    font-size: clamp(28px, 3.5vw, 40px);
    font-weight: 700; letter-spacing: -0.02em; line-height: 1.15;
    margin: 0 0 20px; color: var(--ink);
    max-width: 720px;
  }
  .section-lead {
    font-size: 17px; color: var(--ink-muted);
    max-width: 640px; margin: 0 0 48px; line-height: 1.6;
  }

  /* ─────────── slack mockup ─────────── */
  .mockup-wrap {
    display: grid; grid-template-columns: 1fr; gap: 56px;
    align-items: start;
  }
  @media (min-width: 900px) {
    .mockup-wrap { grid-template-columns: 1.1fr 1fr; gap: 64px; }
  }
  .mockup-narrative h3 {
    font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
    margin: 0 0 12px; color: var(--ink);
  }
  .mockup-narrative h3 .step {
    color: var(--brand);
    font-variant-numeric: tabular-nums;
    margin-right: 10px; font-weight: 800;
  }
  .mockup-narrative p {
    color: var(--ink-muted); margin: 0 0 32px;
    font-size: 15px; line-height: 1.65;
  }

  .slack-window {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-card);
    overflow: hidden;
    font-size: 14px;
  }
  .slack-titlebar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
    border-bottom: 1px solid var(--border);
  }
  .slack-traffic { display: flex; gap: 6px; }
  .slack-traffic span {
    width: 10px; height: 10px; border-radius: 50%;
    display: inline-block;
  }
  .slack-traffic span:nth-child(1) { background: #ff5f57; }
  .slack-traffic span:nth-child(2) { background: #febc2e; }
  .slack-traffic span:nth-child(3) { background: #28c840; }
  .slack-channel {
    color: var(--ink-muted); font-size: 13px; font-weight: 600;
    margin-left: 6px;
  }
  .slack-channel .hash { color: var(--ink-faint); margin-right: 2px; }

  .slack-body { padding: 18px 20px; background: #fff; }
  .slack-msg {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 8px 0;
  }
  .slack-msg + .slack-msg { margin-top: 2px; }
  .slack-avatar {
    flex: 0 0 36px;
    width: 36px; height: 36px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px; color: #fff;
    letter-spacing: -0.02em;
  }
  .slack-avatar.owner { background: linear-gradient(135deg, #f59e0b, #ef4444); }
  .slack-avatar.bot   { background: linear-gradient(135deg, #2563eb, #4f46e5); }
  .slack-avatar.lisa  { background: linear-gradient(135deg, #10b981, #14b8a6); }
  .slack-content { flex: 1; min-width: 0; }
  .slack-name {
    font-weight: 700; font-size: 14px; color: var(--ink);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .slack-time { color: var(--ink-faint); font-size: 12px; font-weight: 400; margin-left: 6px; }
  .slack-badge {
    display: inline-flex; align-items: center;
    background: var(--brand-soft); color: var(--brand);
    padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.02em;
  }
  .slack-text { color: var(--ink); margin-top: 2px; word-wrap: break-word; }
  .slack-text .mention { color: var(--brand); font-weight: 600; }

  .slack-card {
    margin-top: 8px;
    border-left: 3px solid var(--brand);
    background: var(--bg-soft);
    border-radius: 0 8px 8px 0;
    padding: 12px 14px;
    font-size: 13px;
    color: var(--ink-muted);
  }
  .slack-card .row { margin: 3px 0; }
  .slack-card .row strong { color: var(--ink); font-weight: 600; }
  .slack-divider {
    margin: 14px 0;
    height: 1px; background: var(--border-soft);
    position: relative;
  }
  .slack-divider::after {
    content: attr(data-label);
    position: absolute; top: 50%; left: 20px;
    transform: translateY(-50%);
    background: #fff; padding: 0 10px;
    color: var(--ink-faint); font-size: 11px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase;
  }

  /* ─────────── principles ─────────── */
  .principles { display: grid; grid-template-columns: 1fr; gap: 20px; }
  @media (min-width: 720px) {
    .principles { grid-template-columns: repeat(3, 1fr); gap: 20px; }
  }
  .principle {
    padding: 28px 26px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 160ms ease, transform 160ms ease;
  }
  .principle:hover { border-color: var(--brand); transform: translateY(-2px); }
  .principle .icon {
    width: 36px; height: 36px; border-radius: 8px;
    background: var(--brand-soft); color: var(--brand);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700;
    margin-bottom: 18px;
  }
  .principle h3 {
    font-size: 17px; font-weight: 700; color: var(--ink);
    margin: 0 0 8px; letter-spacing: -0.01em;
  }
  .principle p {
    font-size: 14px; color: var(--ink-muted);
    margin: 0; line-height: 1.6;
  }

  /* ─────────── final CTA ─────────── */
  .final-cta {
    margin: 80px auto 80px;
    max-width: 1180px;
    padding: 64px 32px;
    background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);
    border: 1px solid var(--border);
    border-radius: 20px;
    text-align: center;
  }
  .final-cta h2 {
    font-size: clamp(26px, 3vw, 36px);
    font-weight: 700; letter-spacing: -0.02em;
    margin: 0 0 14px; color: var(--ink);
  }
  .final-cta p {
    color: var(--ink-muted); max-width: 540px;
    margin: 0 auto 28px; font-size: 16px; line-height: 1.6;
  }

  /* ─────────── footer ─────────── */
  footer {
    border-top: 1px solid var(--border-soft);
    padding: 32px;
    color: var(--ink-faint); font-size: 13px;
    text-align: center;
  }
  footer .powered {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 4px;
    color: var(--ink-muted);
  }
  footer .powered .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--brand);
  }

  /* ─────────── small status pages ─────────── */
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
    background: var(--brand-soft); color: var(--brand);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 28px; margin-bottom: 20px;
  }
  .center-card.error .glyph { background: #fef2f2; color: #dc2626; }
  .center-card h1 {
    font-size: 26px; font-weight: 700; letter-spacing: -0.02em;
    margin: 0 0 12px; color: var(--ink);
  }
  .center-card p {
    color: var(--ink-muted); font-size: 15px; line-height: 1.6;
    margin: 10px 0;
  }
  .center-card code {
    display: block;
    background: var(--bg-soft); color: var(--ink);
    padding: 14px 16px; border-radius: 8px;
    font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 13px;
    text-align: left;
    margin: 20px 0;
    border: 1px solid var(--border);
  }
  .center-card .next-steps {
    text-align: left;
    margin: 24px 0 0;
    padding: 20px 22px;
    background: var(--bg-soft);
    border-radius: 10px;
    border: 1px solid var(--border-soft);
  }
  .center-card .next-steps h3 {
    font-size: 13px; font-weight: 700; color: var(--brand);
    margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .center-card .next-steps ol {
    margin: 0; padding-left: 18px;
    color: var(--ink-muted); font-size: 14px; line-height: 1.7;
  }
  .center-card .next-steps li + li { margin-top: 4px; }
  .center-card .next-steps strong { color: var(--ink); font-weight: 600; }
</style>
`;

const SLACK_ICON_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M5.04 15.16a2.13 2.13 0 1 1-2.13-2.13h2.13v2.13zm1.07 0a2.13 2.13 0 0 1 4.26 0v5.33a2.13 2.13 0 0 1-4.26 0v-5.33zM8.24 5.04a2.13 2.13 0 1 1 2.13-2.13v2.13H8.24zm0 1.07a2.13 2.13 0 0 1 0 4.26H2.91a2.13 2.13 0 0 1 0-4.26h5.33zM18.36 8.24a2.13 2.13 0 1 1 2.13 2.13h-2.13V8.24zm-1.07 0a2.13 2.13 0 0 1-4.26 0V2.91a2.13 2.13 0 0 1 4.26 0v5.33zM15.16 18.36a2.13 2.13 0 1 1-2.13 2.13v-2.13h2.13zm0-1.07a2.13 2.13 0 0 1 0-4.26h5.33a2.13 2.13 0 0 1 0 4.26h-5.33z"/>
</svg>`;

function langSwitcher(lang: Lang, basePath: string, c: Copy): string {
  // Switching is via URL — `/?lang=en` vs `/?lang=zh`. SEO-friendly, works without JS,
  // and the page state is shareable. basePath is the path of the current page so the
  // link points back to "this page in the other language".
  const enHref = `${basePath}?lang=en`;
  const zhHref = `${basePath}?lang=zh`;
  return `
  <div class="lang-switch" aria-label="${c.switcher.ariaSwitchTo}">
    <a class="${lang === 'en' ? 'active' : ''}" href="${enHref}" hreflang="en" aria-current="${
      lang === 'en' ? 'true' : 'false'
    }">${c.switcher.en}</a>
    <span class="sep">·</span>
    <a class="${lang === 'zh' ? 'active' : ''}" href="${zhHref}" hreflang="zh" aria-current="${
      lang === 'zh' ? 'true' : 'false'
    }">${c.switcher.zh}</a>
  </div>`;
}

function navBar(installUrl: string, lang: Lang, basePath: string, c: Copy): string {
  return `
  <nav class="top">
    <div class="brand-mark">
      <span class="brand-dot"></span>
      <span>Aiptima</span>
    </div>
    <div class="nav-right">
      ${langSwitcher(lang, basePath, c)}
      <a class="cta-mini" href="${installUrl}">${c.nav.addToSlack}</a>
    </div>
  </nav>`;
}

function footer(c: Copy): string {
  return `
  <footer>
    <div class="powered"><span class="dot"></span> ${c.footer.powered}</div>
  </footer>`;
}

export function installLandingHtml(installUrl: string, lang: Lang = 'en'): string {
  const c = COPY[lang];
  const m = c.mockup;
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${c.meta.title}</title>
  <meta name="description" content="${c.meta.description}" />
  <link rel="alternate" hreflang="en" href="/?lang=en" />
  <link rel="alternate" hreflang="zh" href="/?lang=zh" />
  <link rel="alternate" hreflang="x-default" href="/?lang=en" />
  ${STYLES}
</head>
<body>

  ${navBar(installUrl, lang, '/', c)}

  <header class="hero">
    <div class="eyebrow"><span class="pulse"></span> ${c.hero.eyebrow}</div>
    <h1 class="hero-title">
      ${c.hero.titleLine1}<br/>
      <span class="accent">${c.hero.titleAccent}</span>
    </h1>
    <p class="hero-sub">${c.hero.sub}</p>
    <div class="cta-row">
      <a class="cta-primary" href="${installUrl}">
        ${SLACK_ICON_SVG}
        ${c.hero.cta}
      </a>
    </div>
    <div class="cta-meta">
      <strong>${c.hero.meta}</strong>
    </div>
  </header>

  <section class="block">
    <div class="section-eyebrow">${c.workflow.eyebrow}</div>
    <h2 class="section-title">${c.workflow.title}</h2>
    <p class="section-lead">${c.workflow.lead}</p>

    <div class="mockup-wrap">
      <div class="mockup-narrative">
        ${c.workflow.steps
          .map(
            (s) => `
        <h3><span class="step">${s.n}</span>${s.title}</h3>
        <p>${s.body}</p>`
          )
          .join('')}
      </div>

      <div class="slack-window" role="img" aria-label="Slack ${m.dmLabel}">
        <div class="slack-titlebar">
          <div class="slack-traffic"><span></span><span></span><span></span></div>
          <div class="slack-channel"><span class="hash">#</span>${m.channel}</div>
        </div>
        <div class="slack-body">

          <div class="slack-msg">
            <div class="slack-avatar owner">${m.owner.initial}</div>
            <div class="slack-content">
              <div class="slack-name">${m.owner.name}<span class="slack-time">${m.owner.t1}</span></div>
              <div class="slack-text">${m.owner.text1}</div>
            </div>
          </div>

          <div class="slack-msg">
            <div class="slack-avatar bot">A</div>
            <div class="slack-content">
              <div class="slack-name">${m.bot1.name}<span class="slack-badge">BOT</span><span class="slack-time">${m.bot1.t1}</span></div>
              <div class="slack-text">${m.bot1.lead}</div>
              <div class="slack-card">
                <div class="row">① <strong>${m.bot1.line1Title}</strong> · <span class="mention">${m.bot1.line1Meta}</span></div>
                <div class="row">② <strong>${m.bot1.line2Title}</strong> · <span class="mention">${m.bot1.line2Meta}</span></div>
                <div class="row" style="color: var(--ink-faint); margin-top: 6px;">${m.bot1.note}</div>
              </div>
            </div>
          </div>

          <div class="slack-divider" data-label="${m.dmLabel}"></div>

          <div class="slack-msg">
            <div class="slack-avatar bot">A</div>
            <div class="slack-content">
              <div class="slack-name">${m.bot1.name}<span class="slack-badge">BOT</span><span class="slack-time">${m.dmBot.t1}</span></div>
              <div class="slack-text">${m.dmBot.text}</div>
            </div>
          </div>

          <div class="slack-msg">
            <div class="slack-avatar lisa">${m.lisa.initial}</div>
            <div class="slack-content">
              <div class="slack-name">${m.lisa.name}<span class="slack-time">${m.lisa.t1}</span></div>
              <div class="slack-text">${m.lisa.text}</div>
            </div>
          </div>

          <div class="slack-divider" data-label="${m.syncLabel}"></div>

          <div class="slack-msg">
            <div class="slack-avatar bot">A</div>
            <div class="slack-content">
              <div class="slack-name">${m.bot1.name}<span class="slack-badge">BOT</span><span class="slack-time">${m.syncBot.t1}</span></div>
              <div class="slack-text">${m.syncBot.text}</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  </section>

  <section class="block">
    <div class="section-eyebrow">${c.principles.eyebrow}</div>
    <h2 class="section-title">${c.principles.title}</h2>
    <p class="section-lead">${c.principles.lead}</p>

    <div class="principles">
      ${c.principles.cards
        .map(
          (card) => `
      <div class="principle">
        <div class="icon">${card.glyph}</div>
        <h3>${card.title}</h3>
        <p>${card.body}</p>
      </div>`
        )
        .join('')}
    </div>
  </section>

  <div class="final-cta">
    <h2>${c.finalCta.title}</h2>
    <p>${c.finalCta.sub}</p>
    <a class="cta-primary" href="${installUrl}">
      ${SLACK_ICON_SVG}
      ${c.finalCta.cta}
    </a>
  </div>

  ${footer(c)}

</body></html>`;
}

export function successHtml(lang: Lang = 'en'): string {
  const c = COPY[lang];
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${c.success.title}</title>
  ${STYLES}
</head>
<body>
  <nav class="top">
    <div class="brand-mark"><span class="brand-dot"></span><span>Aiptima</span></div>
    <div class="nav-right">${langSwitcher(lang, '/', c)}</div>
  </nav>
  <div class="center-shell">
    <div class="center-card">
      <div class="glyph">✓</div>
      <h1>${c.success.titleHead}</h1>
      <p>${c.success.body}</p>

      <div class="next-steps">
        <h3>${c.success.nextSteps}</h3>
        <ol>
          <li>${c.success.step1}</li>
          <li>${c.success.step2}</li>
        </ol>
        <code>${c.success.example}</code>
        <ol start="3">
          <li>${c.success.step3}</li>
          <li>${c.success.step4}</li>
        </ol>
      </div>
    </div>
  </div>
  ${footer(c)}
</body></html>`;
}

export function failureHtml(error?: string, lang: Lang = 'en'): string {
  const c = COPY[lang];
  const safe = error ? error.replace(/</g, '&lt;') : 'Unknown error';
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${c.failure.title}</title>
  ${STYLES}
</head>
<body>
  <nav class="top">
    <div class="brand-mark"><span class="brand-dot"></span><span>Aiptima</span></div>
    <div class="nav-right">${langSwitcher(lang, '/', c)}</div>
  </nav>
  <div class="center-shell">
    <div class="center-card error">
      <div class="glyph">!</div>
      <h1>${c.failure.titleHead}</h1>
      <p>${safe}</p>
      <p>${c.failure.retry}</p>
    </div>
  </div>
  ${footer(c)}
</body></html>`;
}

export function sendHtml(res: Response, html: string, status = 200): void {
  res.status(status).type('html').send(html);
}
