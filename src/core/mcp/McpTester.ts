/**
 * McpTester - Tests MCP server connections and retrieves tool lists.
 *
 * Spawns MCP servers and queries their available tools via the MCP protocol.
 */

import { type ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';

import { getEnhancedPath } from '../../utils/env';
import {
  consumeSseStream,
  parseCommand,
  parseRpcId,
  postJsonRpc,
  resolveSseEndpoint,
  tryParseJson,
  waitForRpcResponse,
} from '../../utils/mcp';
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

/** Extract error message from MCP JSON-RPC response. */
function getMcpError(response: Record<string, unknown>): string | undefined {
  const error = response.error as { message?: string } | undefined;
  return error?.message;
}

/** Test an MCP server connection and retrieve its tools. */
export async function testMcpServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const type = getMcpServerType(server.config);

  try {
    if (type === 'stdio') {
      return await testStdioServer(server);
    } else if (type === 'sse') {
      return await testSseServer(server);
    } else {
      return await testHttpServer(server);
    }
  } catch (error) {
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/** Test a stdio MCP server. */
async function testStdioServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const config = server.config as { command: string; args?: string[]; env?: Record<string, string> };
  const { cmd, args } = parseCommand(config.command, config.args);

  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let initReceived = false;
    let serverInfo: { name?: string; version?: string } = {};

    const cleanup = () => {
      if (child && !child.killed) {
        child.kill();
      }
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({
          success: false,
          tools: [],
          error: 'Connection timeout (10s)',
        });
      }
    }, 10000);

    try {
      if (!cmd) {
        clearTimeout(timeout);
        resolve({
          success: false,
          tools: [],
          error: 'Missing command',
        });
        return;
      }

      // Use direct spawn with command + args
      // Enhance PATH for GUI apps (Obsidian has minimal PATH)
      // Server-specified PATH from config takes priority
      child = spawn(cmd, args, {
        env: { ...process.env, ...config.env, PATH: getEnhancedPath(config.env?.PATH) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (data) => {
        stdout += data.toString();

        // Parse each line
        const lines = stdout.split('\n');
        stdout = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            // Only process responses to our requests (id 1 = initialize, id 2 = tools/list)
            // Ignore any other messages (notifications, errors for unknown methods, etc.)

            // Handle initialize response (id: 1)
            if (msg.id === 1) {
              if (msg.error) {
                // Initialize failed
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  cleanup();
                  resolve({
                    success: false,
                    tools: [],
                    error: msg.error.message || 'Initialize failed',
                  });
                }
                return;
              }

              if (msg.result) {
                initReceived = true;
                serverInfo = {
                  name: msg.result.serverInfo?.name,
                  version: msg.result.serverInfo?.version,
                };

                // Send initialized notification (some servers require it)
                const initializedNotification = {
                  jsonrpc: '2.0',
                  method: 'notifications/initialized',
                };
                child?.stdin?.write(JSON.stringify(initializedNotification) + '\n');

                // Send tools/list request
                const toolsRequest = {
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'tools/list',
                  params: {},
                };
                child?.stdin?.write(JSON.stringify(toolsRequest) + '\n');
              }
            }

            // Handle tools/list response (id: 2)
            if (msg.id === 2) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                cleanup();

                if (msg.error) {
                  // tools/list failed but init succeeded - partial success
                  resolve({
                    success: true,
                    serverName: serverInfo.name,
                    serverVersion: serverInfo.version,
                    tools: [],
                  });
                  return;
                }

                const tools = (msg.result?.tools || []).map(
                  (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                  })
                );
                resolve({
                  success: true,
                  serverName: serverInfo.name,
                  serverVersion: serverInfo.version,
                  tools,
                });
              }
              return;
            }

            // Ignore all other messages (notifications, errors for unknown methods, etc.)
          } catch {
            // Not valid JSON, continue
          }
        }
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            tools: [],
            error: `Failed to start: ${error.message}`,
          });
        }
      });

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (initReceived) {
            // Server closed but we got init - return partial success
            resolve({
              success: true,
              serverName: serverInfo.name,
              serverVersion: serverInfo.version,
              tools: [],
            });
          } else if (code !== 0) {
            resolve({
              success: false,
              tools: [],
              error: stderr || `Process exited with code ${code}`,
            });
          }
        }
      });

      // Send MCP initialize request
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claudian-tester', version: '1.0.0' },
        },
      };

      child.stdin?.write(JSON.stringify(initRequest) + '\n');
    } catch (error) {
      resolved = true;
      clearTimeout(timeout);
      resolve({
        success: false,
        tools: [],
        error: error instanceof Error ? error.message : 'Failed to spawn process',
      });
    }
  });
}

/** Make an HTTP POST request and return the raw response body. */
function httpRequest(
  url: URL,
  headers: Record<string, string>,
  body: string
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, data });
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse a response that may be JSON or SSE format.
 * For SSE format, extracts JSON from the first `data:` line only.
 * Returns the parsed object or null if parsing fails.
 */
function parseJsonOrSse(data: string): Record<string, unknown> | null {
  const trimmed = data.trim();

  // Try parsing as JSON first
  try {
    return JSON.parse(trimmed);
  } catch {
    // May be SSE format - extract JSON from data lines
    const dataMatch = trimmed.match(/^data:\s*(.+)$/m);
    if (dataMatch) {
      try {
        return JSON.parse(dataMatch[1]);
      } catch {
        // Not valid JSON in SSE
      }
    }
  }

  return null;
}

/**
 * Test an HTTP MCP server.
 * Supports both standard JSON and streaming (SSE) response formats.
 */
async function testHttpServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const config = server.config as { url: string; headers?: Record<string, string> };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        success: false,
        tools: [],
        error: 'Connection timeout (10s)',
      });
    }, 10000);

    (async () => {
      try {
        const url = new URL(config.url);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...config.headers,
        };

        // Step 1: Initialize
        const initRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'claudian-tester', version: '1.0.0' },
          },
        });

        const initResponse = await httpRequest(url, headers, initRequest);

        let serverName: string | undefined;
        let serverVersion: string | undefined;

        // Parse response - may be JSON or SSE format
        const initResult = parseJsonOrSse(initResponse.data);

        if (!initResult) {
          clearTimeout(timeout);
          resolve({
            success: false,
            tools: [],
            error: `Invalid response: ${initResponse.data.slice(0, 200)}`,
          });
          return;
        }

        const initError = getMcpError(initResult);
        if (initError) {
          clearTimeout(timeout);
          resolve({
            success: false,
            tools: [],
            error: initError,
          });
          return;
        }

        const resultField = initResult.result as { serverInfo?: { name?: string; version?: string } } | undefined;
        if (resultField?.serverInfo) {
          serverName = resultField.serverInfo.name;
          serverVersion = resultField.serverInfo.version;
        }

        // Step 2: Send initialized notification (optional, some servers need it)
        const initializedNotification = JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        });
        // Fire and forget - some servers may not support it
        httpRequest(url, headers, initializedNotification).catch(() => {
          // Expected for some servers
        });

        // Step 3: Request tools list
        const toolsRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

        const toolsResponse = await httpRequest(url, headers, toolsRequest);

        // Parse tools response - may be JSON or SSE format
        const toolsResult = parseJsonOrSse(toolsResponse.data);
        clearTimeout(timeout);

        if (!toolsResult) {
          resolve({
            success: true,
            serverName,
            serverVersion,
            tools: [],
          });
          return;
        }

        if (getMcpError(toolsResult)) {
          // Tools request failed but init succeeded - partial success
          resolve({
            success: true,
            serverName,
            serverVersion,
            tools: [],
          });
          return;
        }

        const resultObj = toolsResult.result as { tools?: McpTool[] } | undefined;
        const tools = (resultObj?.tools || []).map(
          (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })
        );

        resolve({
          success: true,
          serverName,
          serverVersion,
          tools,
        });
      } catch (error) {
        clearTimeout(timeout);
        resolve({
          success: false,
          tools: [],
          error: error instanceof Error ? error.message : 'Request failed',
        });
      }
    })();
  });
}

/** Test an SSE MCP server. */
async function testSseServer(server: ClaudianMcpServer): Promise<McpTestResult> {
  const config = server.config as { url: string; headers?: Record<string, string> };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const sseUrl = new URL(config.url);
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...config.headers,
    };

    const response = await fetch(sseUrl.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      return {
        success: false,
        tools: [],
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    let endpointResolved = false;
    let resolveEndpoint: ((url: URL) => void) | null = null;

    const endpointPromise = new Promise<URL>((resolve) => {
      resolveEndpoint = resolve;
    });

    const pending = new Map<number, (msg: Record<string, unknown>) => void>();

    const streamPromise = consumeSseStream(response.body, (event) => {
      if (!endpointResolved) {
        const candidate = resolveSseEndpoint(event.data, sseUrl);
        if (candidate) {
          endpointResolved = true;
          resolveEndpoint?.(candidate);
        }
      }

      const payload = tryParseJson(event.data);
      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        const id = parseRpcId(record.id);
        if (id !== null) {
          const handler = pending.get(id);
          if (handler) {
            handler(record);
          }
        }
      }
    }).catch(() => {
      // May be expected on abort
    });

    let endpointTimeout: NodeJS.Timeout | null = null;
    const endpointTimeoutPromise = new Promise<URL>((_, reject) => {
      endpointTimeout = setTimeout(() => reject(new Error('SSE endpoint not advertised')), 5000);
    });

    let postUrl: URL;
    try {
      postUrl = await Promise.race([endpointPromise, endpointTimeoutPromise]);
    } finally {
      if (endpointTimeout) clearTimeout(endpointTimeout);
    }
    const postOptions = { signal: controller.signal, timeoutMs: 8000 };

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claudian-tester', version: '1.0.0' },
      },
    };

    const initResponsePromise = waitForRpcResponse(pending, 1, 8000);
    initResponsePromise.catch(() => {
      // May be expected
    });
    const initPost = await postJsonRpc(postUrl, config.headers ?? {}, initRequest, postOptions);
    if (initPost.status >= 400) {
      initResponsePromise.catch(() => {
        // Cleanup after HTTP error
      });
      clearTimeout(timeout);
      controller.abort();
      return {
        success: false,
        tools: [],
        error: `HTTP ${initPost.status}: ${initPost.statusText}`,
      };
    }

    const initResponse = await initResponsePromise;
    const initError = (initResponse as { error?: { message?: string } }).error;

    if (initError) {
      clearTimeout(timeout);
      controller.abort();
      return {
        success: false,
        tools: [],
        error: initError.message || 'Initialize failed',
      };
    }

    const serverInfo = (initResponse as { result?: { serverInfo?: { name?: string; version?: string } } })
      .result;

    const serverName = serverInfo?.serverInfo?.name;
    const serverVersion = serverInfo?.serverInfo?.version;

    // Send initialized notification
    await postJsonRpc(postUrl, config.headers ?? {}, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, postOptions).catch(() => {
      // Expected for some servers
    });

    // Request tools list
    const toolsResponsePromise = waitForRpcResponse(pending, 2, 8000);
    toolsResponsePromise.catch(() => {
      // May be expected
    });
    await postJsonRpc(postUrl, config.headers ?? {}, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, postOptions);

    let tools: McpTool[] = [];
    try {
      const toolsResponse = await toolsResponsePromise;
      const toolsError = (toolsResponse as { error?: { message?: string } }).error;
      if (!toolsError) {
        const result = (toolsResponse as { result?: { tools?: McpTool[] } }).result;
        tools = (result?.tools || []).map(
          (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })
        );
      }
    } catch {
      // Ignore tools timeout for partial success
    }

    clearTimeout(timeout);
    controller.abort();
    await streamPromise;

    return {
      success: true,
      serverName,
      serverVersion,
      tools,
    };
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : 'Request failed',
    };
  }
}
