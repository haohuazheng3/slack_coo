import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function parseTaskFromText(text: string) {
  const prompt = `You are a structured task parsing assistant. Convert human natural language task descriptions into JSON format. Example:
  
Input: "Remind me to attend a meeting tomorrow at 3 PM"
Output: {
  "title": "Meeting",
  "time": "2025-07-26T15:00:00",
  "assignee": "Me"
}

Please parse the following text:
"${text}"
Output:`;

  const completion = await openai.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "gpt-4",
  });

  const response = completion.choices[0].message.content;

  try {
    const parsed = JSON.parse(response!);
    return parsed;
  } catch (e) {
    console.error("GPT response could not be parsed into JSON", response);
    return null;
  }
}
