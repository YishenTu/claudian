export function extractMcpMentions(text: string, validNames: Set<string>): Set<string> {
  const mentions = new Set<string>();
  const regex = /@([a-zA-Z0-9._-]+)(?!\/)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    if (validNames.has(name)) {
      mentions.add(name);
    }
  }

  return mentions;
}

/**
 * Transform MCP mentions in text by appending " MCP" after each valid @mention.
 * This is applied to the API request only, not shown in the input.
 */
export function transformMcpMentions(text: string, validNames: Set<string>): string {
  if (validNames.size === 0) return text;

  // Sort names by length (longest first) to avoid partial matches
  const sortedNames = Array.from(validNames).sort((a, b) => b.length - a.length);

  // Build single pattern with alternation (more efficient than N passes)
  const escapedNames = sortedNames.map(escapeRegExp).join('|');
  // Match @name that:
  // - is not already followed by " MCP"
  // - is not followed by "/" (context folder)
  // - is not followed by alphanumeric/underscore/hyphen (partial match)
  // - is not followed by "." + word char (e.g., @test in @test.server)
  // This allows @server. (period as punctuation) while preventing @test.foo matches
  const pattern = new RegExp(
    `@(${escapedNames})(?! MCP)(?!/)(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`,
    'g'
  );

  return text.replace(pattern, '@$1 MCP');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseCommand(command: string, providedArgs?: string[]): { cmd: string; args: string[] } {
  if (providedArgs && providedArgs.length > 0) {
    return { cmd: command, args: providedArgs };
  }

  const parts = splitCommandString(command);
  if (parts.length === 0) {
    return { cmd: '', args: [] };
  }

  return { cmd: parts[0], args: parts.slice(1) };
}

function quoteCommandPart(part: string): string {
  if (part.length > 0 && !/[\s'"\\]/.test(part)) {
    return part;
  }

  const escaped = part
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Format structured command parts for display without losing argument boundaries. */
export function formatCommand(command: string, args: string[] = []): string {
  return [command, ...args]
    .map(quoteCommandPart)
    .join(' ');
}

export function splitCommandString(cmdStr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let tokenStarted = false;

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if (char === '\\') {
      const next = cmdStr[i + 1];
      const isEscaped = next !== undefined && (
        inQuote
          ? quoteChar === '"' && (next === '"' || next === '\\')
          : /\s/.test(next) || next === '"' || next === "'"
      );

      if (isEscaped) {
        current += next;
        tokenStarted = true;
        i++;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
      tokenStarted = true;
      continue;
    }

    if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
      continue;
    }

    if (/\s/.test(char) && !inQuote) {
      if (tokenStarted) {
        parts.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (tokenStarted) {
    parts.push(current);
  }

  return parts;
}
