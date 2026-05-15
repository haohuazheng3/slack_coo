import { describe, it, expect } from 'vitest';
import { extractFunctionCalls } from '../src/orchestrator/parseAiResponse';

describe('extractFunctionCalls', () => {
  it('returns cleaned text when no tokens', () => {
    const { cleanedText, calls } = extractFunctionCalls('Hello there.');
    expect(cleanedText).toBe('Hello there.');
    expect(calls).toEqual([]);
  });

  it('extracts a single tool call with JSON payload', () => {
    const { cleanedText, calls } = extractFunctionCalls(
      'Got it.\n[CreateTask] {"title":"Hi","assignee":"<@U1>"}'
    );
    expect(cleanedText).toBe('Got it.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('CreateTask');
    expect(calls[0]?.rawArguments).toBe('{"title":"Hi","assignee":"<@U1>"}');
  });

  it('extracts multiple tool calls', () => {
    const { cleanedText, calls } = extractFunctionCalls(
      'Will do.\n[AskClarification] {"question":"When?"}\n[CreateTask] {"title":"X"}'
    );
    expect(cleanedText).toBe('Will do.');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).toBe('AskClarification');
    expect(calls[1]?.name).toBe('CreateTask');
  });

  it('keeps inline brackets that are not tool names', () => {
    const { cleanedText, calls } = extractFunctionCalls(
      'See [the docs] for details.'
    );
    expect(cleanedText).toContain('[the docs]');
    expect(calls).toEqual([]);
  });

  it('handles nested braces inside the JSON payload', () => {
    const { calls } = extractFunctionCalls(
      '[UpdateTaskDetails] {"taskId":"t1","metadata":{"a":{"b":1}}}'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rawArguments).toBe(
      '{"taskId":"t1","metadata":{"a":{"b":1}}}'
    );
  });

  it('handles braces inside string values', () => {
    const { calls } = extractFunctionCalls(
      '[CreateTask] {"title":"a } literal brace","assignee":"<@U1>"}'
    );
    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.rawArguments!);
    expect(parsed.title).toBe('a } literal brace');
  });

  it('treats malformed JSON as no payload', () => {
    const { calls } = extractFunctionCalls('[CreateTask] {bad');
    expect(calls[0]?.name).toBe('CreateTask');
    expect(calls[0]?.rawArguments).toBeUndefined();
  });

  it('rejects lowercase tool names (must be PascalCase)', () => {
    const { cleanedText, calls } = extractFunctionCalls('[note] {"x":1}');
    expect(calls).toEqual([]);
    expect(cleanedText).toContain('[note]');
  });
});
