import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import * as http from 'http';
import * as https from 'https';

import { getEnhancedPath } from '../../utils/env';
import { parseCommand } from '../../utils/mcp';
import type { ClaudianMcpServer } from '../types';
import { getMcpServerType } from '../types';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTestResult {
  success: boolean;
  serverName?: string;
  serverVersion?: string;
  tools: McpTool[];
  error?: string;
}

interface UrlServerConfig {
  url: string;
  headers?: Record<string, string>;
}

/**
 * Custom MCP transport using Node.js native http/https modules.
 * Bypasses browser CORS restrictions that block Obsidian's Electron renderer
 * (Origin: app://obsidian.md) from connecting to MCP servers.
 */
class NodeHttpTransport {
  private _url: URL;
  private _headers: Record<string, string>;
  private _sessionId?: string;

  // Transport interface callbacks
  onmessage?: (message: unknown) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(url: URL, headers?: Record<string, string>) {
    this._url = url;
    this._headers = headers ?? {};
  }

  async start(): Promise<void> {
    // Nothing to do on start — the Client will send initialize via send()
  }

  async send(message: unknown): Promise<void> {
    const body = JSON.stringify(message);
    const mod = this._url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
      ...this._headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this._sessionId) {
      headers['mcp-session-id'] = this._sessionId;
    }

    return new Promise<void>((resolve, reject) => {
      const req = mod.request(
        this._url,
        { method: 'POST', headers },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const sessionHeader = res.headers['mcp-session-id'];
            if (sessionHeader) {
              this._sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
            }

            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }

            const text = Buffer.concat(chunks).toString('utf-8').trim();
            if (!text) {
              resolve();
              return;
            }

            // Handle SSE-formatted responses (content-type: text/event-stream)
            const contentType = res.headers['content-type'] ?? '';
            if (contentType.includes('text/event-stream')) {
              const lines = text.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim();
                  if (data) {
                    try {
                      this.onmessage?.(JSON.parse(data));
                    } catch {
                      // Skip unparseable SSE data lines
                    }
                  }
                }
              }
              resolve();
              return;
            }

            // Handle JSON response
            try {
              this.onmessage?.(JSON.parse(text));
              resolve();
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          });
          res.on('error', (err: Error) => reject(err));
        },
      );

      req.on('error', (err: Error) => reject(err));
      req.write(body);
      req.end();
    });
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

export async function testMcpServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const type = getMcpServerType(server.config);

  let transport;
  try {
    if (type === 'stdio') {
      const config = server.config as { command: string; args?: string[]; env?: Record<string, string> };
      const { cmd, args } = parseCommand(config.command, config.args);
      if (!cmd) {
        return { success: false, tools: [], error: 'Missing command' };
      }
      transport = new StdioClientTransport({
        command: cmd,
        args,
        env: { ...process.env, ...config.env, PATH: getEnhancedPath(config.env?.PATH) } as Record<string, string>,
        stderr: 'ignore',
      });
    } else {
      const config = server.config as UrlServerConfig;
      const url = new URL(config.url);
      transport = new NodeHttpTransport(url, config.headers);
    }
  } catch (error) {
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : 'Invalid server configuration',
    };
  }

  const client = new Client({ name: 'claudian-tester', version: '1.0.0' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    await client.connect(transport, { signal: controller.signal });

    const serverVersion = client.getServerVersion();
    let tools: McpTool[] = [];
    try {
      const result = await client.listTools(undefined, { signal: controller.signal });
      tools = result.tools.map((t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch {
      // listTools failure after successful connect = partial success
    }

    return {
      success: true,
      serverName: serverVersion?.name,
      serverVersion: serverVersion?.version,
      tools,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { success: false, tools: [], error: 'Connection timeout (10s)' };
    }
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeout);
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
  }
}
