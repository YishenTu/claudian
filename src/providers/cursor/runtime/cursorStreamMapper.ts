import type { StreamChunk } from '../../../core/types';

export interface CursorReduceResult {
  chunks: StreamChunk[];
  sessionId?: string;
}

function extractAssistantText(record: Record<string, unknown>): string {
  const msg = record.message;
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      out += b.text;
    }
  }
  return out;
}

function parseToolStart(record: Record<string, unknown>): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} | null {
  const callId = typeof record.call_id === 'string' ? record.call_id : '';
  if (!callId) {
    return null;
  }

  const tc = record.tool_call;
  if (!tc || typeof tc !== 'object') {
    return null;
  }
  const t = tc as Record<string, unknown>;

  const read = t.readToolCall;
  if (read && typeof read === 'object') {
    const args = (read as { args?: Record<string, unknown> }).args ?? {};
    return { id: callId, name: 'read_file', input: { ...args } };
  }

  const write = t.writeToolCall;
  if (write && typeof write === 'object') {
    const w = write as { args?: Record<string, unknown> };
    const args = w.args ?? {};
    return { id: callId, name: 'write_file', input: { ...args } };
  }

  const fn = t.function;
  if (fn && typeof fn === 'object') {
    const f = fn as { name?: string; arguments?: string };
    const name = typeof f.name === 'string' ? f.name : 'function';
    let input: Record<string, unknown> = {};
    if (typeof f.arguments === 'string' && f.arguments.trim()) {
      try {
        input = JSON.parse(f.arguments) as Record<string, unknown>;
      } catch {
        input = { raw: f.arguments };
      }
    }
    return { id: callId, name, input };
  }

  return { id: callId, name: 'tool', input: { tool_call: tc } };
}

function stringifyToolResult(record: Record<string, unknown>): string {
  const tc = record.tool_call;
  if (tc && typeof tc === 'object') {
    try {
      return JSON.stringify(tc);
    } catch {
      return String(tc);
    }
  }
  return JSON.stringify(record);
}

export class CursorNdjsonStreamReducer {
  private assistantAcc = '';

  reset(): void {
    this.assistantAcc = '';
  }

  reduceLine(line: string): CursorReduceResult {
    const trimmed = line.trim();
    if (!trimmed) {
      return { chunks: [] };
    }

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return { chunks: [] };
    }

    const sessionId = typeof rec.session_id === 'string' ? rec.session_id : undefined;
    const type = rec.type;

    if (type === 'system' || type === 'user') {
      return { chunks: [], sessionId };
    }

    if (type === 'assistant') {
      const full = extractAssistantText(rec);
      const delta = full.startsWith(this.assistantAcc)
        ? full.slice(this.assistantAcc.length)
        : full;
      this.assistantAcc = full;
      const chunks: StreamChunk[] = delta ? [{ type: 'text', content: delta }] : [];
      return { chunks, sessionId };
    }

    if (type === 'tool_call') {
      const subtype = rec.subtype;
      if (subtype === 'started') {
        this.assistantAcc = '';
        const tool = parseToolStart(rec);
        if (!tool) {
          return { chunks: [], sessionId };
        }
        return {
          chunks: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }],
          sessionId,
        };
      }

      if (subtype === 'completed') {
        const callId = typeof rec.call_id === 'string' ? rec.call_id : '';
        if (!callId) {
          return { chunks: [], sessionId };
        }
        const content = stringifyToolResult(rec);
        return {
          chunks: [{ type: 'tool_result', id: callId, content }],
          sessionId,
        };
      }

      return { chunks: [], sessionId };
    }

    if (type === 'result') {
      this.assistantAcc = '';
      if (rec.is_error === true) {
        const msg = typeof rec.result === 'string'
          ? rec.result
          : 'Cursor Agent run failed';
        return {
          chunks: [{ type: 'error', content: msg }, { type: 'done' }],
          sessionId,
        };
      }
      const chunks: StreamChunk[] = [
        {
          type: 'usage',
          usage: {
            inputTokens: 0,
            contextWindow: 200_000,
            contextTokens: 0,
            percentage: 0,
          },
          sessionId: sessionId ?? null,
        },
        { type: 'done' },
      ];
      return { chunks, sessionId };
    }

    return { chunks: [], sessionId };
  }
}
