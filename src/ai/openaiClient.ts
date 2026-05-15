import { OpenAI } from 'openai';

// dotenv is loaded once in src/index.ts (the entrypoint).
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

