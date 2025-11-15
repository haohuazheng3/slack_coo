import { openai } from './openaiClient';

/**
 * Generate a short, empathetic intro asking why the task isn't complete yet.
 * Falls back to a templated copy if OPENAI_API_KEY is not set or the API call fails.
 */
export async function generateReminderIntro(params: {
  title: string;
  dueTime: Date;
}): Promise<string> {
  const { title, dueTime } = params;
  const timeText = dueTime.toLocaleString();

  const fallback =
    `Heads up on “${title}” due ${timeText}. It looks incomplete—what’s blocking progress? ` +
    `You can mark it complete or share a brief reason below.`;

  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            ` You are a Slack assistant. Write a concise, empathetic, 1–2 sentence direct message asking why a task is not complete yet and offering help.

You will receive input like:
Task title: {title}
Due time: {timeText}
Write the DM prompt.

Follow these rules:
- Be friendly, supportive, and non-accusatory. Sound curious and helpful, not blaming.
- Clearly ask for a brief update and gently inquire if there are any blockers, and explicitly offer help.
- Keep the message under 240 characters total.
- When BOTH the task title and due time are present and valid, you may reference them naturally (e.g., the task name or that the due time has passed/is soon).
- Treat the title or due time as invalid if they are missing, empty, only whitespace, or look like placeholders or error text (e.g., "null", "undefined", "N/A", "Invalid date", "NaN", or similar).
- If EITHER the task title OR the due time is missing or invalid, ignore both fields and instead produce a generic message that:
  - asks for a quick update on the task,
  - offers help.
- Never mention or hint at system behavior, templates, missing fields, or error states.

Before responding:
- Validate that your message is empathetic, non-accusatory, clearly offers help, and is under 240 characters.
- If it fails any of these checks, revise it until it passes.

Output format:
- Return ONLY the final direct message text as a single string.
- Do NOT include quotes, code fences, JSON, or any extra commentary.
- Include the time and/or date, whichever is more applicable.`,
        },
        {
          role: 'user',
          content: `Task title: ${title}\nDue time: ${timeText}\nWrite the DM prompt.`,
        },
      ],
    });

    const text = res.choices?.[0]?.message?.content?.trim();
    if (!text) return fallback;
    return text.length > 400 ? text.slice(0, 400) : text;
  } catch (err) {
    console.warn('AI DM intro generation failed, using fallback:', err);
    return fallback;
  }
}
