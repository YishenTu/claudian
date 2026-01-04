export interface SseEvent {
  event?: string;
  data: string;
}

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

export function splitCommandString(cmdStr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
      continue;
    }

    if (/\s/.test(char) && !inQuote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;

    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (!event && dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';

      for (const part of parts) {
        const event = parseSseEvent(part);
        if (event) {
          onEvent(event);
        }
      }
    }
  } catch {
    // Ignore stream errors (commonly triggered by abort)
  } finally {
    reader.releaseLock();
  }
}

export function parseRpcId(id: unknown): number | null {
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && id.trim()) {
    const asNumber = Number(id);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return null;
}

export function tryParseJson(data: string): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function resolveSseEndpoint(data: string, baseUrl: URL): URL | null {
  const payload = tryParseJson(data);
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const endpoint =
      (typeof record.endpoint === 'string' && record.endpoint) ||
      (typeof record.messageEndpoint === 'string' && record.messageEndpoint) ||
      (typeof record.url === 'string' && record.url) ||
      (typeof record.messageUrl === 'string' && record.messageUrl);

    if (endpoint) {
      try {
        return new URL(endpoint, baseUrl);
      } catch {
        return null;
      }
    }
  }

  const trimmed = data.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
}

export function waitForRpcResponse(
  pending: Map<number, (msg: Record<string, unknown>) => void>,
  id: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Response timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    pending.set(id, (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(msg);
    });
  });
}

export type PostJsonRpcOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function postJsonRpc(
  url: URL,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  options: PostJsonRpcOptions = {}
): Promise<Response> {
  const requestHeaders: Record<string, string> = { ...headers };
  if (!requestHeaders['Content-Type']) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  let controller: AbortController | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let signal: AbortSignal | undefined = options.signal;

  if (options.timeoutMs !== undefined || options.signal) {
    controller = new AbortController();
    signal = controller.signal;
  }

  const abortHandler = () => controller?.abort();

  if (controller && options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  if (controller && options.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => controller?.abort(), options.timeoutMs);
  }

  const requestInit: RequestInit = {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(payload),
  };

  if (signal) {
    requestInit.signal = signal;
  }

  try {
    return await fetch(url.toString(), requestInit);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    if (controller && options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}
