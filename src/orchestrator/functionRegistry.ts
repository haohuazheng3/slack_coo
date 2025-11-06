import { PrismaClient } from '@prisma/client';
import { WebClient } from '@slack/web-api';

export type SlackExecutionContext = {
  client: WebClient;
  channelId: string;
  userId: string;
  rawText: string;
  threadTs?: string;
  send: (message: string | { text: string; blocks?: any[] }) => Promise<void>;
};

export type FunctionExecutionContext = {
  slack: SlackExecutionContext;
  prisma: PrismaClient;
};

export type FunctionExecutionResult = {
  status: 'success' | 'error';
  message?: string;
  data?: any;
};

export type RegisteredFunction = {
  name: string;
  description: string;
  inputExample: string;
  handler: (args: any, context: FunctionExecutionContext) => Promise<FunctionExecutionResult>;
};

export class FunctionRegistry {
  private functions: Map<string, RegisteredFunction> = new Map();

  register(func: RegisteredFunction) {
    this.functions.set(func.name, func);
  }

  get(name: string): RegisteredFunction | undefined {
    return this.functions.get(name);
  }

  list(): RegisteredFunction[] {
    return Array.from(this.functions.values());
  }
}

