export type ParsedFunctionCall = {
  name: string;
  rawArguments?: string;
};

export function extractFunctionCalls(responseText: string): {
  cleanedText: string;
  calls: ParsedFunctionCall[];
} {
  const calls: ParsedFunctionCall[] = [];
  let cleaned = '';
  let cursor = 0;

  while (cursor < responseText.length) {
    const start = responseText.indexOf('[', cursor);
    if (start === -1) {
      cleaned += responseText.slice(cursor);
      break;
    }

    const end = responseText.indexOf(']', start + 1);
    if (end === -1) {
      cleaned += responseText.slice(cursor);
      break;
    }

    const name = responseText.slice(start + 1, end).trim();
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      cleaned += responseText.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }

    cleaned += responseText.slice(cursor, start);

    let argumentStart = end + 1;
    while (argumentStart < responseText.length && /\s/.test(responseText[argumentStart])) {
      argumentStart++;
    }

    let rawArguments: string | undefined;

    if (responseText[argumentStart] === '{') {
      let depth = 0;
      let i = argumentStart;
      for (; i < responseText.length; i++) {
        const char = responseText[i];
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            rawArguments = responseText.slice(argumentStart, i + 1);
            cursor = i + 1;
            break;
          }
        }
      }

      if (depth !== 0) {
        // malformed JSON, treat it as plain text
        rawArguments = undefined;
        cursor = argumentStart;
      }
    } else {
      cursor = argumentStart;
    }

    calls.push({ name, rawArguments });
  }

  const cleanedText = cleaned.trim();
  return { cleanedText, calls };
}

