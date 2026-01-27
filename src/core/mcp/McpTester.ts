import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

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

export async function testMcpServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const type = getMcpServerType(server.config);

  let transport;
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
    const options = config.headers ? { requestInit: { headers: config.headers } } : undefined;
    transport = type === 'sse'
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);
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
