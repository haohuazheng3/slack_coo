import { PrismaClient } from '@prisma/client';
import { normalizeToDBTask, ParsedTaskInput } from '../services/normalizeTask';
import { postTaskReminder } from '../slack/postTaskReminder';

const prisma = new PrismaClient();

export async function writeTaskToDB(parsed: ParsedTaskInput) {
  try {
    const data = normalizeToDBTask(parsed);
    const created = await prisma.task.create({ data });
    console.log("✅ Task saved to DB:", created);

    try {
      await postTaskReminder(created);
      console.log("📢 Slack reminder posted for task:", created.title);
    } catch (err) {
      console.error("❌ Failed to post Slack reminder:", err);
    }

    return created;
  } catch (e) {
    console.error("❌ Failed to save task:", e);
    return null;
  }
}
