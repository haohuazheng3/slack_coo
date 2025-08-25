import { PrismaClient } from '@prisma/client';
import { normalizeToDBTask, ParsedTaskInput } from '../services/normalizeTask';

const prisma = new PrismaClient();

export async function writeTaskToDB(parsed: ParsedTaskInput) {
  try {
    const data = normalizeToDBTask(parsed);
    const created = await prisma.task.create({ data });
    console.log("✅ Task saved to DB:", created);
    return created;
  } catch (e) {
    console.error("❌ Failed to save task:", e);
    return null;
  }
}

