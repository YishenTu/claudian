type JsonTokenType = 'brace' | 'bracket' | 'separator' | 'delimiter' | 'string' | 'number' | 'name';

type JsonToken = {
  type: JsonTokenType;
  value: string;
};

type ToolUseSnapshot = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
};

type ToolUseFields = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export interface TransformStreamState {
  registerToolUse(parentToolUseId: string | null, index: number, toolUse: ToolUseFields): void;
  applyInputJsonDelta(parentToolUseId: string | null, index: number, partialJson: string): ToolUseFields | null;
  clearContentBlock(parentToolUseId: string | null, index: number): void;
  clearParent(parentToolUseId: string | null): void;
  clearAll(): void;
}

const MAIN_AGENT_STREAM = '__main__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getContentBlockKey(parentToolUseId: string | null, index: number): string {
  return `${parentToolUseId ?? MAIN_AGENT_STREAM}:${index}`;
}

function getParentPrefix(parentToolUseId: string | null): string {
  return `${parentToolUseId ?? MAIN_AGENT_STREAM}:`;
}

function findClosingTokenIndex(tokens: JsonToken[], value: string): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.value === value) {
      return index;
    }
  }
  return -1;
}

function tokenizePartialJson(input: string): JsonToken[] {
  const tokens: JsonToken[] = [];
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

function stripIncompleteTail(tokens: JsonToken[]): JsonToken[] {
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

function closeOpenContainers(tokens: JsonToken[]): JsonToken[] {
  const completedTokens = [...tokens];
  const closingTokens: JsonToken[] = [];

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

function renderJson(tokens: JsonToken[]): string {
  return tokens
    .map((token) => token.type === 'string' ? `"${token.value}"` : token.value)
    .join('');
}

function parsePartialToolInput(input: string): Record<string, unknown> | null {
  const tokens = tokenizePartialJson(input);
  if (tokens.length === 0) {
    return {};
  }

  try {
    const repairedJson = renderJson(closeOpenContainers(stripIncompleteTail(tokens)));
    return normalizeToolInput(JSON.parse(repairedJson));
  } catch {
    return null;
  }
}

export function createTransformStreamState(): TransformStreamState {
  const activeToolUses = new Map<string, ToolUseSnapshot>();

  return {
    registerToolUse(parentToolUseId, index, toolUse) {
      activeToolUses.set(getContentBlockKey(parentToolUseId, index), {
        ...toolUse,
        input: { ...toolUse.input },
        partialJson: '',
      });
    },
    applyInputJsonDelta(parentToolUseId, index, partialJson) {
      const snapshot = activeToolUses.get(getContentBlockKey(parentToolUseId, index));
      if (!snapshot) {
        return null;
      }

      snapshot.partialJson += partialJson;
      const parsedInput = parsePartialToolInput(snapshot.partialJson);
      if (parsedInput === null) {
        return null;
      }

      snapshot.input = {
        ...snapshot.input,
        ...parsedInput,
      };

      return {
        id: snapshot.id,
        name: snapshot.name,
        input: { ...snapshot.input },
      };
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
