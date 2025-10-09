import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function parseTaskFromText(text: string) {
  const prompt = `
You are a strict task parser. Convert user input into a JSON with the following fields:
- title: task title (string)
- time: ISO datetime string (e.g., "2025-08-24T09:00:00Z"). Leave empty if not clear.
- reminder_time: original relative description if given (e.g., "2 minutes later"). Otherwise empty.
- assignee: primary responsible person, prefer Slack mention form (e.g., "<@UXXXX>").
- assignees: array of ALL mentioned users in Slack mention form (e.g., ["<@UXXXX>", "<@UYYYY>"]).
Only output valid JSON, nothing else.
Input: """${text}"""
`;


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
