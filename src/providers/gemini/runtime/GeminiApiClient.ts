interface GeminiTextPart {
  text: string;
  thought?: boolean;
}

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiFunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export type GeminiPart = GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiStreamDelta {
  text?: string;
  thought?: string;
  functionCalls?: GeminiFunctionCall[];
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiGenerateParams {
  model: string;
  contents: GeminiContent[];
  systemInstruction?: string;
  temperature?: number;
  tools?: GeminiFunctionDeclaration[];
  signal?: AbortSignal;
}

interface GeminiClientOptions {
  apiKey: string;
  baseUrl?: string;
}

function extractTextFromParts(parts: GeminiPart[] | undefined, thought: boolean): string {
  if (!parts) return '';
  return parts
    .map((part) => {
      if (!('text' in part)) return '';
      if (!!part.thought !== thought) return '';
      return part.text;
    })
    .join('');
}

function extractFunctionCalls(parts: GeminiPart[] | undefined): GeminiFunctionCall[] {
  if (!parts) return [];
  const calls: GeminiFunctionCall[] = [];
  for (const part of parts) {
    if ('functionCall' in part && part.functionCall?.name) {
      calls.push({
        id: part.functionCall.id,
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    }
  }
  return calls;
}

function parseGeminiResponseChunk(chunk: any): GeminiStreamDelta {
  const parts = chunk?.candidates?.[0]?.content?.parts as GeminiPart[] | undefined;
  const text = extractTextFromParts(parts, false);
  const thought = extractTextFromParts(parts, true);
  const functionCalls = extractFunctionCalls(parts);
  const usageMetadata = chunk?.usageMetadata as GeminiUsageMetadata | undefined;

  return {
    ...(text ? { text } : {}),
    ...(thought ? { thought } : {}),
    ...(functionCalls.length > 0 ? { functionCalls } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

export class GeminiApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: GeminiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
      .replace(/\/+$/, '');
  }

  async generateText(params: GeminiGenerateParams): Promise<{
    text: string;
    usageMetadata?: GeminiUsageMetadata;
  }> {
    const response = await fetch(this.buildUrl(params.model, 'generateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildRequestBody(params)),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(await this.extractErrorMessage(response));
    }

    const json = await response.json();
    const parts = json?.candidates?.[0]?.content?.parts as GeminiPart[] | undefined;
    return {
      text: extractTextFromParts(parts, false),
      usageMetadata: json?.usageMetadata,
    };
  }

  async *streamGenerateContent(params: GeminiGenerateParams): AsyncGenerator<GeminiStreamDelta> {
    const response = await fetch(this.buildUrl(params.model, 'streamGenerateContent', 'alt=sse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildRequestBody(params)),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(await this.extractErrorMessage(response));
    }

    if (!response.body) {
      const fallback = await response.json();
      yield parseGeminiResponseChunk(fallback);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = this.findSseBoundary(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = this.extractSseData(event);
        if (data && data !== '[DONE]') {
          yield parseGeminiResponseChunk(JSON.parse(data));
        }
        boundary = this.findSseBoundary(buffer);
      }
    }

    const remaining = buffer.trim();
    if (remaining) {
      const data = this.extractSseData(remaining);
      if (data && data !== '[DONE]') {
        yield parseGeminiResponseChunk(JSON.parse(data));
      }
    }
  }

  private buildRequestBody(params: GeminiGenerateParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: params.contents,
      generationConfig: {
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      },
    };

    if (params.systemInstruction?.trim()) {
      body.systemInstruction = {
        parts: [{ text: params.systemInstruction }],
      };
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = [{ functionDeclarations: params.tools }];
    }

    return body;
  }

  private buildUrl(model: string, method: string, query?: string): string {
    const normalizedModel = model.replace(/^models\//, '');
    const sep = query ? `&${query}` : '';
    return `${this.baseUrl}/models/${encodeURIComponent(normalizedModel)}:${method}?key=${encodeURIComponent(this.apiKey)}${sep}`;
  }

  private extractSseData(event: string): string | null {
    const dataLines = event
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim());

    return dataLines.length > 0 ? dataLines.join('\n') : null;
  }

  private findSseBoundary(buffer: string): { index: number; length: number } | null {
    const candidates = [
      { index: buffer.indexOf('\r\n\r\n'), length: 4 },
      { index: buffer.indexOf('\n\n'), length: 2 },
      { index: buffer.indexOf('\r\r'), length: 2 },
    ].filter(candidate => candidate.index >= 0);

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a.index - b.index);
    return candidates[0];
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      const json = await response.json();
      const message = json?.error?.message || JSON.stringify(json);
      return `Gemini API error (${response.status}): ${message}`;
    } catch {
      return `Gemini API error (${response.status}): ${await response.text()}`;
    }
  }
}
