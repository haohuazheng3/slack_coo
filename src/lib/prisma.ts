import { PrismaClient } from '@prisma/client';

declare global {

  var __slackCooPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__slackCooPrisma ?? new PrismaClient({ log: ['error', 'warn'] });

if (process.env.NODE_ENV !== 'production') {
  global.__slackCooPrisma = prisma;
}
