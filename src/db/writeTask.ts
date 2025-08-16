import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function writeTaskToDB(task: {
  title: string;
  time: string;
  assignee: string;
  channelId: string;
  createdBy: string;
}) {
  try {
    const created = await prisma.task.create({
      data: {
        ...task,
        time: new Date(task.time),
      },
    });

    console.log("✅ import to database successfully:", created);
    return created;
  } catch (e) {
    console.error("❌ failed to import:", e);
    return null;
  }
}
