/*
 * The partial-JSON tokenizer and repair below are adapted from @anthropic-ai/sdk's vendored
 * copy (src/_vendor/partial-json-parser/parser.ts, MIT) of the npm package partial-json-parser,
 * which that SDK uses to preview streamed tool input.
 */

type JSONTokenType = 'brace' | 'bracket' | 'separator' | 'delimiter' | 'string' | 'number' | 'name';

type JSONToken = {
  type: JSONTokenType;
  value: string;
};

export type ToolUseFields = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolUseSnapshot = ToolUseFields & {
  partialJson: string;
  /** Lexical position at the end of partialJson, carried across deltas. */
  inString: boolean;
  escaped: boolean;
};

export interface TransformStreamState {
  registerToolUse(parentToolUseId: string | null, index: number, toolUse: ToolUseFields): void;
  applyInputJsonDelta(parentToolUseId: string | null, index: number, partialJson: string): ToolUseFields | null;
  clearContentBlock(parentToolUseId: string | null, index: number): void;
  clearParent(parentToolUseId: string | null): void;
  clearAll(): void;
}

const MAIN_AGENT_STREAM = '__main__';

export function normalizeToolInput(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getContentBlockKey(parentToolUseId: string | null, index: number): string {
  return `${parentToolUseId ?? MAIN_AGENT_STREAM}:${index}`;
}

function getParentPrefix(parentToolUseId: string | null): string {
  return `${parentToolUseId ?? MAIN_AGENT_STREAM}:`;
}

function findClosingTokenIndex(tokens: JSONToken[], value: string): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.value === value) {
      return index;
    }
  }
  return -1;
}

function tokenizePartialJSON(input: string): JSONToken[] {
  const tokens: JSONToken[] = [];
  let index = 0;

  while (index < input.length) {
    let char = input[index] ?? '';

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '{' || char === '}') {
      tokens.push({ type: 'brace', value: char });
      index += 1;
      continue;
    }

    if (char === '[' || char === ']') {
      tokens.push({ type: 'bracket', value: char });
      index += 1;
      continue;
    }

    if (char === ':') {
      tokens.push({ type: 'separator', value: char });
      index += 1;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'delimiter', value: char });
      index += 1;
      continue;
    }

    if (char === '"') {
      let value = '';
      let isDanglingString = false;
      index += 1;
      char = input[index] ?? '';

      while (char !== '"') {
        if (index === input.length) {
          isDanglingString = true;
          break;
        }

        if (char === '\\') {
          index += 1;
          if (index === input.length) {
            isDanglingString = true;
            break;
          }
          value += char + (input[index] ?? '');
          index += 1;
          char = input[index] ?? '';
          continue;
        }

        value += char;
        index += 1;
        char = input[index] ?? '';
      }

      index += 1;
      if (!isDanglingString) {
        tokens.push({ type: 'string', value });
      }
      continue;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9]/.test(char) || char === '-' || char === '.') {
      let value = '';

      if (char === '-') {
        value += char;
        index += 1;
        char = input[index] ?? '';
      }

      while (/[0-9]/.test(char) || char === '.') {
        value += char;
        index += 1;
        char = input[index] ?? '';
      }

      tokens.push({ type: 'number', value });
      continue;
    }

    if (/[a-z]/i.test(char)) {
      let value = '';

      while (/[a-z]/i.test(char)) {
        value += char;
        index += 1;
        char = input[index] ?? '';
      }

      if (value === 'true' || value === 'false' || value === 'null') {
        tokens.push({ type: 'name', value });
      } else {
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return tokens;
}

function stripIncompleteTail(tokens: JSONToken[]): JSONToken[] {
  if (tokens.length === 0) {
    return tokens;
  }

  const lastToken = tokens[tokens.length - 1];
  if (!lastToken) {
    return tokens;
  }

  switch (lastToken.type) {
    case 'separator':
    case 'delimiter':
      return stripIncompleteTail(tokens.slice(0, -1));
    case 'number': {
      const lastChar = lastToken.value[lastToken.value.length - 1];
      return lastChar === '.' || lastChar === '-'
        ? stripIncompleteTail(tokens.slice(0, -1))
        : tokens;
    }
    case 'string': {
      const previousToken = tokens[tokens.length - 2];
      if (previousToken?.type === 'delimiter') {
        return stripIncompleteTail(tokens.slice(0, -1));
      }
      if (previousToken?.type === 'brace' && previousToken.value === '{') {
        return stripIncompleteTail(tokens.slice(0, -1));
      }
      return tokens;
    }
    default:
      return tokens;
  }
}

function closeOpenContainers(tokens: JSONToken[]): JSONToken[] {
  const completedTokens = [...tokens];
  const closingTokens: JSONToken[] = [];

  for (const token of completedTokens) {
      if (token.type === 'brace') {
        if (token.value === '{') {
          closingTokens.push({ type: 'brace', value: '}' });
        } else {
          const closingIndex = findClosingTokenIndex(closingTokens, '}');
          if (closingIndex >= 0) {
            closingTokens.splice(closingIndex, 1);
          }
        }
        continue;
    }

    if (token.type === 'bracket') {
      if (token.value === '[') {
        closingTokens.push({ type: 'bracket', value: ']' });
      } else {
        const closingIndex = findClosingTokenIndex(closingTokens, ']');
        if (closingIndex >= 0) {
          closingTokens.splice(closingIndex, 1);
        }
      }
    }
  }

  for (let index = closingTokens.length - 1; index >= 0; index -= 1) {
    const token = closingTokens[index];
    if (token) {
      completedTokens.push(token);
    }
  }

  return completedTokens;
}

function renderJSON(tokens: JSONToken[]): string {
  return tokens
    .map((token) => token.type === 'string' ? `"${token.value}"` : token.value)
    .join('');
}

function parsePartialToolInput(input: string): Record<string, unknown> | null {
  const tokens = tokenizePartialJSON(input);
  if (tokens.length === 0) {
    return {};
  }

  try {
    const repairedJson = renderJSON(closeOpenContainers(stripIncompleteTail(tokens)));
    return normalizeToolInput(JSON.parse(repairedJson));
  } catch {
    return null;
  }
}

/**
 * Scans only the new delta and reports whether it can change the repaired parse. Text inside an
 * unterminated string and whitespace between tokens are dropped by the tokenizer, so deltas made
 * only of those leave the snapshot unchanged and need no reparse of the accumulated buffer.
 */
function consumeDelta(snapshot: ToolUseSnapshot, delta: string): boolean {
  let changesParse = false;
  for (const char of delta) {
    if (snapshot.inString) {
      if (snapshot.escaped) {
        snapshot.escaped = false;
      } else if (char === '\\') {
        snapshot.escaped = true;
      } else if (char === '"') {
        snapshot.inString = false;
        changesParse = true;
      }
    } else if (char === '"') {
      snapshot.inString = true;
    } else if (!/\s/.test(char)) {
      changesParse = true;
    }
  }
  return changesParse;
}

export function createTransformStreamState(): TransformStreamState {
  const activeToolUses = new Map<string, ToolUseSnapshot>();

  return {
    registerToolUse(parentToolUseId, index, toolUse) {
      activeToolUses.set(getContentBlockKey(parentToolUseId, index), {
        ...toolUse,
        partialJson: '',
        inString: false,
        escaped: false,
      });
    },
    applyInputJsonDelta(parentToolUseId, index, partialJson) {
      const snapshot = activeToolUses.get(getContentBlockKey(parentToolUseId, index));
      if (!snapshot) {
        return null;
      }

      snapshot.partialJson += partialJson;
      if (!consumeDelta(snapshot, partialJson)) {
        return null;
      }
      const parsedInput = parsePartialToolInput(snapshot.partialJson);
      if (parsedInput === null) {
        return null;
      }

      // Replaced rather than mutated, so emitted inputs stay stable after later deltas.
      snapshot.input = { ...snapshot.input, ...parsedInput };
      return { id: snapshot.id, name: snapshot.name, input: snapshot.input };
    },
    clearContentBlock(parentToolUseId, index) {
      activeToolUses.delete(getContentBlockKey(parentToolUseId, index));
    },
    clearParent(parentToolUseId) {
      const parentPrefix = getParentPrefix(parentToolUseId);
      for (const key of activeToolUses.keys()) {
        if (key.startsWith(parentPrefix)) {
          activeToolUses.delete(key);
        }
      }
    },
    clearAll() {
      activeToolUses.clear();
    },
  };
}
