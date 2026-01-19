/**
 * IFlowClient - iFlow ACP (Agent Client Protocol) Client
 *
 * Implements the Agent Client Protocol for communicating with iFlow CLI.
 * Uses stdio (standard input/output) for communication, which is the
 * standard ACP transport mechanism.
 *
 * Protocol flow:
 * 1. Spawn iFlow process with --experimental-acp
 * 2. Send initialize request via stdin
 * 3. Create session with session/new
 * 4. Send prompts with session/prompt
 * 5. Receive session/update notifications via stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import type {
  IFlowMessage,
  IFlowOptions,
  IFlowQueryOptions,
  IIFlowClient,
  AssistantMessage,
  ToolCallMessage,
  ToolCallStatus,
  PlanEntry,
} from './types';

// ============================================
// JSON-RPC 2.0 Types
// ============================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ============================================
// ACP Session Update Types
// ============================================

interface SessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;  // Can be: agent_message_chunk, tool_call, tool_result, plan, thinking, etc.
    // For agent_message_chunk
    content?: {
      type: string;
      text?: string;
    } | string | unknown[];
    // For text updates (legacy)
    text?: string;
    // For tool call updates
    toolCallId?: string;
    toolName?: string;
    name?: string;  // Alternative field name
    input?: Record<string, unknown>;
    args?: Record<string, unknown>;  // iFlow uses 'args' instead of 'input'
    status?: string;
    title?: string;
    kind?: string;
    locations?: unknown[];
    // For tool result
    result?: string;
    isError?: boolean;
    // For plan updates
    entries?: Array<{
      content: string;
      priority?: string;
      status?: string;
    }>;
    // For thinking updates
    thinking?: string;
  };
}

// ============================================
// Message Iterator
// ============================================

class MessageIterator implements AsyncIterableIterator<IFlowMessage> {
  private client: IFlowClient;
  private initialized = false;
  private content: string;
  private images?: Array<{ data: string; mediaType: string }>;
  private options?: IFlowQueryOptions;
  private done = false;

  constructor(
    client: IFlowClient,
    content: string,
    images?: Array<{ data: string; mediaType: string }>,
    options?: IFlowQueryOptions
  ) {
    this.client = client;
    this.content = content;
    this.images = images;
    this.options = options;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<IFlowMessage> {
    return this;
  }

  async next(): Promise<IteratorResult<IFlowMessage, undefined>> {
    if (this.done) {
      return { done: true, value: undefined };
    }

    if (!this.initialized) {
      await this.client.initializeQueryInternal(this.content, this.images, this.options);
      this.initialized = true;
    }

    const message = await this.client.waitForMessageInternal();
    if (message === null) {
      this.done = true;
      this.client.clearAbortController();
      return { done: true, value: undefined };
    }

    if (message.type === 'task_finish' || message.type === 'error') {
      this.done = true;
      this.client.clearAbortController();
    }

    return { done: false, value: message };
  }

  async return(): Promise<IteratorResult<IFlowMessage, undefined>> {
    this.done = true;
    this.client.abortCurrent();
    return { done: true, value: undefined };
  }
}

// ============================================
// IFlowClient Implementation (stdio mode)
// ============================================

export class IFlowClient implements IIFlowClient {
  private options: IFlowOptions;
  private process: ChildProcess | null = null;
  private sessionId: string | null = null;
  private connected = false;
  private acpInitialized = false;
  private messageQueue: IFlowMessage[] = [];
  private messageResolvers: Array<(value: IFlowMessage | null) => void> = [];
  private pendingRequests: Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private currentAbortController: AbortController | null = null;
  private requestId = 0;
  private buffer = '';
  
  /** Enable debug logging */
  private debugEnabled = true;
  
  /** Activity timeout for prompt requests (ms) - resets on each message */
  private activityTimeoutMs = 120000; // 2 minutes of inactivity
  
  /** Timer for activity-based timeout */
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** Callback for activity timeout */
  private activityTimeoutCallback: (() => void) | null = null;
  
  /**
   * Conditional debug logging.
   */
  private log(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[IFlowClient]', ...args);
    }
  }
  
  /**
   * Always log errors.
   */
  private logError(...args: unknown[]): void {
    console.error('[IFlowClient]', ...args);
  }
  
  /**
   * Reset the activity timer. Called when any message is received.
   * This implements "inactivity timeout" instead of "total timeout".
   */
  private resetActivityTimer(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    
    if (this.activityTimeoutCallback) {
      this.activityTimer = setTimeout(() => {
        this.log('Activity timeout - no messages received for', this.activityTimeoutMs, 'ms');
        if (this.activityTimeoutCallback) {
          this.activityTimeoutCallback();
        }
      }, this.activityTimeoutMs);
    }
  }
  
  /**
   * Clear the activity timer.
   */
  private clearActivityTimer(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    this.activityTimeoutCallback = null;
  }

  constructor(options: IFlowOptions = {}) {
    this.options = {
      host: 'localhost',
      port: 8765,
      timeout: 30000,
      autoStart: true,
      cliPath: '/Users/stackjane/.npm-global/bin/iflow',
      ...options,
    };
    
    // Enable debug logging via environment or options
    this.debugEnabled = options.debug ?? (process.env.IFLOW_DEBUG === 'true');
  }

  /**
   * Connect to iFlow by spawning the process.
   */
  async connect(): Promise<void> {
    if (this.connected && this.process) {
      return;
    }

    const cliPath = this.options.cliPath || 'iflow';
    const cwd = this.options.cwd || process.cwd?.() || '/';

    this.log('Spawning iFlow process:', cliPath);
    this.log('Working directory:', cwd);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.logError('Connection timeout');
        this.cleanup();
        reject(new Error(`Connection timeout. Make sure iFlow CLI is installed.`));
      }, this.options.timeout || 30000);

      try {
        // Spawn iFlow in ACP stdio mode
        this.process = spawn(cliPath, ['--experimental-acp', '--yolo'], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...this.options.env,
          },
        });

        this.process.on('error', (error) => {
          clearTimeout(timeoutId);
          this.logError('Process error:', error);
          this.connected = false;
          reject(new Error(`无法启动 iFlow: ${error.message}`));
        });

        this.process.on('exit', (code, signal) => {
          this.log('Process exited:', { code, signal });
          this.connected = false;
          this.acpInitialized = false;
          this.process = null;
          
          // Resolve all pending requests with error
          for (const [, pending] of this.pendingRequests) {
            pending.reject(new Error('iFlow process exited'));
          }
          this.pendingRequests.clear();
          
          // Resolve all message resolvers with null
          for (const resolver of this.messageResolvers) {
            resolver(null);
          }
          this.messageResolvers = [];
        });

        // Handle stdout (JSON-RPC messages)
        this.process.stdout?.on('data', (data: Buffer) => {
          this.handleData(data.toString());
        });

        // Handle stderr (debug output)
        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          // Check for ready signal or just log
          this.log('stderr:', text.trim());
        });

        // Give the process a moment to start, then initialize
        setTimeout(async () => {
          clearTimeout(timeoutId);
          this.connected = true;
          this.log('Process started, initializing ACP...');
          
          try {
            await this.initializeAcp();
            resolve();
          } catch (error) {
            this.logError('ACP initialization failed:', error);
            this.cleanup();
            reject(error);
          }
        }, 1000);

      } catch (error) {
        clearTimeout(timeoutId);
        this.logError('Failed to spawn process:', error);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming data from stdout.
   */
  private handleData(data: string): void {
    this.buffer += data;
    
    // Reset activity timer on any data received
    this.resetActivityTimer();
    
    // Process complete JSON-RPC messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        this.log('Received:', trimmed);
        const parsed = JSON.parse(trimmed) as JsonRpcMessage;
        this.handleMessage(parsed);
      } catch {
        // Not JSON, might be debug output
        this.log('Non-JSON output:', trimmed);
      }
    }
  }

  /**
   * Initialize ACP protocol.
   */
  private async initializeAcp(): Promise<void> {
    this.log('Sending initialize request...');
    
    const result = await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
          listDirectory: true,
        },
        terminal: {
          executeCommand: true,
        },
      },
      clientInfo: {
        name: 'claudian-obsidian',
        version: '1.0.0',
      },
    });

    this.log('ACP initialized:', result);
    this.acpInitialized = true;
  }

  /**
   * Create a new ACP session.
   */
  private async createSession(): Promise<string> {
    this.log('Creating new session...');
    
    const result = await this.sendRequest('session/new', {
      cwd: this.options.cwd || '/',
      mcpServers: [],
    });

    const sessionId = result.sessionId as string;
    this.log('Session created:', sessionId);
    return sessionId;
  }

  /**
   * Send a JSON-RPC request via stdin.
   */
  private sendRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.connected) {
        reject(new Error('Not connected to iFlow'));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });
      
      const message = JSON.stringify(request) + '\n';
      this.log('Sending:', message.trim());
      this.process.stdin?.write(message);

      // For session/prompt, use activity-based timeout (resets on each message)
      // For other requests, use fixed timeout
      if (method === 'session/prompt') {
        // Set up activity timeout callback
        this.activityTimeoutCallback = () => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            this.clearActivityTimer();
            reject(new Error('Request timeout: no activity for ' + (this.activityTimeoutMs / 1000) + ' seconds'));
          }
        };
        // Start the activity timer
        this.resetActivityTimer();
      } else {
        // Fixed timeout for non-prompt requests
        const timeoutMs = this.options.timeout || 30000;
        setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Disconnect from iFlow.
   */
  async disconnect(): Promise<void> {
    this.cleanup();
  }

  /**
   * Cleanup resources.
   */
  private cleanup(): void {
    this.clearActivityTimer();
    
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.acpInitialized = false;
    this.sessionId = null;
    this.buffer = '';

    for (const resolver of this.messageResolvers) {
      resolver(null);
    }
    this.messageResolvers = [];
    this.messageQueue = [];
    this.pendingRequests.clear();
  }

  /**
   * Check if connected to iFlow.
   */
  isConnected(): boolean {
    return this.connected && this.process !== null && this.acpInitialized;
  }

  /**
   * Send a message and receive streaming responses.
   */
  sendMessage(
    content: string,
    options?: IFlowQueryOptions
  ): AsyncIterableIterator<IFlowMessage> {
    return new MessageIterator(this, content, undefined, options);
  }

  /**
   * Send a message with images.
   */
  sendMessageWithImages(
    content: string,
    images: Array<{ data: string; mediaType: string }>,
    options?: IFlowQueryOptions
  ): AsyncIterableIterator<IFlowMessage> {
    return new MessageIterator(this, content, images, options);
  }

  /**
   * Initialize a query by sending the prompt to iFlow.
   */
  async initializeQueryInternal(
    content: string,
    images?: Array<{ data: string; mediaType: string }>,
    _options?: IFlowQueryOptions
  ): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }

    if (!this.sessionId) {
      this.sessionId = await this.createSession();
    }

    this.currentAbortController = new AbortController();
    this.messageQueue = [];

    const promptContent: Array<Record<string, unknown>> = [
      { type: 'text', text: content },
    ];

    if (images && images.length > 0) {
      for (const img of images) {
        promptContent.push({
          type: 'image',
          data: img.data,
          mediaType: img.mediaType,
        });
      }
    }

    this.log('Sending prompt...');
    
    this.sendRequest('session/prompt', {
      sessionId: this.sessionId,
      prompt: promptContent,
    }).then((result) => {
      this.log('Prompt turn completed:', result);
      this.clearActivityTimer();
      const stopReason = result.stopReason as string || 'end_turn';
      this.enqueueMessage({
        type: 'task_finish',
        stopReason,
      });
    }).catch((error) => {
      this.logError('Prompt error:', error);
      this.clearActivityTimer();
      this.enqueueMessage({
        type: 'error',
        message: error.message || 'Unknown error',
      });
    });
  }

  /**
   * Wait for the next message from the queue.
   */
  waitForMessageInternal(): Promise<IFlowMessage | null> {
    const signal = this.currentAbortController?.signal;

    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }

      if (this.messageQueue.length > 0) {
        resolve(this.messageQueue.shift()!);
        return;
      }

      const resolver = (message: IFlowMessage | null) => {
        const index = this.messageResolvers.indexOf(resolver);
        if (index > -1) {
          this.messageResolvers.splice(index, 1);
        }
        resolve(message);
      };

      this.messageResolvers.push(resolver);

      if (signal) {
        const abortHandler = () => {
          const index = this.messageResolvers.indexOf(resolver);
          if (index > -1) {
            this.messageResolvers.splice(index, 1);
          }
          resolve(null);
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  /**
   * Enqueue a message for the iterator.
   */
  private enqueueMessage(message: IFlowMessage): void {
    if (this.messageResolvers.length > 0) {
      const resolver = this.messageResolvers.shift()!;
      resolver(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  clearAbortController(): void {
    this.currentAbortController = null;
  }

  abortCurrent(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  /**
   * Handle incoming JSON-RPC message.
   */
  private handleMessage(parsed: JsonRpcMessage): void {
    // Check if it's a request from the server (has method and id)
    if ('method' in parsed && 'id' in parsed && parsed.id !== undefined) {
      // This is a request from iFlow to the client
      this.handleClientRequest(parsed as JsonRpcRequest);
      return;
    }
    
    // Check if it's a response to our request
    if ('id' in parsed && parsed.id !== undefined && !('method' in parsed)) {
      const response = parsed as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          // Log error but don't necessarily reject - some errors are recoverable
          this.log('Request error:', response.error.message, response.error.data);
          // Only reject if it's a critical error
          if (response.error.code === -32600 || response.error.code === -32601) {
            // Invalid request or method not found - reject
            pending.reject(new Error(response.error.message));
          } else {
            // Other errors (like aborted operations) - resolve with empty result
            // This allows the flow to continue
            pending.resolve({});
          }
        } else {
          pending.resolve(response.result || {});
        }
      }
      return;
    }

    // It's a notification
    if ('method' in parsed) {
      this.handleNotification(parsed as JsonRpcNotification);
    }
  }

  /**
   * Handle ACP notifications.
   */
  private handleNotification(notification: JsonRpcNotification): void {
    this.log('Notification:', notification.method, JSON.stringify(notification.params));

    if (notification.method === 'session/update') {
      const params = notification.params as unknown as SessionUpdateParams;
      const update = params.update;
      const updateType = update.sessionUpdate;

      this.log('Update type:', updateType);

      // Handle agent_message_chunk (text from assistant)
      if (updateType === 'agent_message_chunk' || updateType === 'text') {
        let text = '';
        if (update.content && typeof update.content === 'object' && !Array.isArray(update.content)) {
          const contentObj = update.content as { type: string; text?: string };
          if (contentObj.text) {
            text = contentObj.text;
          }
        } else if (typeof update.content === 'string') {
          text = update.content;
        } else if (update.text) {
          text = update.text;
        }
        
        if (text) {
          this.log('Enqueuing assistant message, length:', text.length);
          this.enqueueMessage({
            type: 'assistant',
            chunk: { text },
          } as AssistantMessage);
        }
        return;
      }

      // Handle tool calls (starting and updates)
      if (updateType === 'tool_call' || updateType === 'toolCall' || updateType === 'tool_call_update') {
        const toolName = update.toolName || update.name || 'unknown';
        const toolInput = update.args || update.input || {};
        const rawStatus = update.status;
        const toolId = update.toolCallId || `tool-${toolName}-${Date.now()}`;
        let status = this.mapToolStatus(rawStatus);
        
        this.log('Tool call:', toolName, 'rawStatus:', rawStatus, 'mappedStatus:', status, 'toolId:', toolId);
        
        // Extract result from content if it's a string or has text
        let result: string | undefined;
        if (typeof update.content === 'string') {
          result = update.content;
        } else if (Array.isArray(update.content) && update.content.length > 0) {
          result = update.content
            .map((c: unknown) => {
              if (typeof c === 'object' && c !== null) {
                const obj = c as Record<string, unknown>;
                if (obj.content && typeof obj.content === 'object') {
                  const inner = obj.content as Record<string, unknown>;
                  if (inner.text) return String(inner.text);
                }
                if (obj.text) return String(obj.text);
              }
              return '';
            })
            .filter(Boolean)
            .join('\n');
        }
        
        // If this is an update message (tool_call_update) with content, mark as completed
        if (updateType === 'tool_call_update' && result) {
          status = 'completed';
        }
        
        // If we have a result and status is still running, it might actually be completed
        if (result && (status === 'running' || status === 'pending')) {
          this.log('Tool has result, marking as completed');
          status = 'completed';
        }
        
        this.enqueueMessage({
          type: 'tool_call',
          label: update.title || toolName,
          status: status,
          toolName: toolName,
          toolId: toolId,
          input: toolInput,
          result: result || update.result,
        } as ToolCallMessage);
        return;
      }

      // Handle tool result (completion)
      if (updateType === 'tool_result' || updateType === 'toolResult') {
        const toolName = update.toolName || update.name || 'unknown';
        this.log('Tool result:', toolName);
        
        this.enqueueMessage({
          type: 'tool_call',
          label: toolName,
          status: update.isError ? 'failed' : 'completed',
          toolName: toolName,
          toolId: update.toolCallId,
          input: update.input,
          result: typeof update.content === 'string' ? update.content : update.result,
        } as ToolCallMessage);
        return;
      }

      // Handle plan
      if (updateType === 'plan') {
        const entries: PlanEntry[] = (update.entries || []).map(e => ({
          content: e.content,
          priority: this.parsePriority(e.priority),
          status: this.parsePlanStatus(e.status),
        }));
        this.enqueueMessage({
          type: 'plan',
          entries,
        });
        return;
      }

      // Handle thinking
      if (updateType === 'thinking') {
        this.enqueueMessage({
          type: 'thinking',
          content: update.thinking || '',
        });
        return;
      }

      this.log('Unknown update type:', updateType);
    }
  }

  private mapToolStatus(status?: string): ToolCallStatus {
    const normalizedStatus = status?.toLowerCase();
    switch (normalizedStatus) {
      case 'pending': return 'pending';
      case 'in_progress': 
      case 'in-progress':
      case 'running': 
      case 'started':
        return 'running';
      case 'completed':
      case 'complete':
      case 'success':
      case 'succeeded':
      case 'done':
      case 'finished':
        return 'completed';
      case 'failed':
      case 'error':
      case 'failure':
        return 'failed';
      default: 
        this.log('Unknown tool status:', status);
        // If status is undefined but we have content, assume completed
        return 'pending';
    }
  }

  private parsePriority(priority?: string): number | undefined {
    if (priority === 'high') return 1;
    if (priority === 'medium') return 2;
    if (priority === 'low') return 3;
    return undefined;
  }

  private parsePlanStatus(status?: string): 'pending' | 'in_progress' | 'completed' | undefined {
    if (status === 'pending' || status === 'in_progress' || status === 'completed') {
      return status;
    }
    return undefined;
  }

  /**
   * Interrupt current operation.
   */
  async interrupt(): Promise<void> {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    if (this.process && this.isConnected() && this.sessionId) {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId: this.sessionId,
        },
      };
      this.process.stdin?.write(JSON.stringify(notification) + '\n');
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Handle requests from iFlow to the client (file system, terminal, etc.)
   */
  private handleClientRequest(request: JsonRpcRequest): void {
    this.log('Client request:', request.method, request.params);
    
    // Reset activity timer - client requests indicate iFlow is still working
    this.resetActivityTimer();
    
    const params = request.params || {};
    
    switch (request.method) {
      case 'fs/read_text_file':
      case 'read_file':  // Alternative method name
        this.handleReadFile(request.id, params as { path: string; line?: number; limit?: number });
        break;
      case 'fs/write_text_file':
      case 'write_file':  // Alternative method name
        this.handleWriteFile(request.id, params as { path: string; content?: string; text?: string });
        break;
      case 'fs/list_directory':
      case 'list_directory':  // Alternative method name
        this.handleListDirectory(request.id, params as { path: string });
        break;
      case 'session/request_permission':
        // Auto-approve in YOLO mode
        this.sendResponse(request.id, { approved: true });
        break;
      default:
        this.log('Unknown client request:', request.method);
        this.sendErrorResponse(request.id, -32601, `Method not found: ${request.method}`);
    }
  }

  /**
   * Send a JSON-RPC response.
   */
  private sendResponse(id: number, result: Record<string, unknown>): void {
    if (!this.process) return;
    
    const response = {
      jsonrpc: '2.0',
      id,
      result,
    };
    const message = JSON.stringify(response) + '\n';
    this.log('Sending response:', message.trim());
    this.process.stdin?.write(message);
  }

  /**
   * Send a JSON-RPC error response.
   */
  private sendErrorResponse(id: number, code: number, message: string): void {
    if (!this.process) return;
    
    const response = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    const msg = JSON.stringify(response) + '\n';
    this.log('Sending error response:', msg.trim());
    this.process.stdin?.write(msg);
  }

  /**
   * Validate that a path is within the allowed working directory.
   * Prevents path traversal attacks and access to files outside the vault.
   */
  private isPathAllowed(targetPath: string): boolean {
    const cwd = this.options.cwd;
    if (!cwd) {
      // No cwd set, deny all file operations for safety
      return false;
    }
    
    // Resolve both paths to absolute paths
    const resolvedTarget = path.resolve(targetPath);
    const resolvedCwd = path.resolve(cwd);
    
    // Check if the target path starts with the cwd
    // Add path.sep to prevent matching partial directory names
    // e.g., /vault-backup should not match /vault
    return resolvedTarget === resolvedCwd || 
           resolvedTarget.startsWith(resolvedCwd + path.sep);
  }

  /**
   * Handle fs/read_text_file request.
   */
  private handleReadFile(id: number, params: { path: string; line?: number; limit?: number }): void {
    const filePath = params.path;
    
    // Security check: ensure path is within allowed directory
    if (!this.isPathAllowed(filePath)) {
      const msg = `Access denied: path "${filePath}" is outside the allowed directory`;
      this.logError(msg);
      this.sendErrorResponse(id, -32000, msg);
      return;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.log('Read file:', filePath, 'length:', content.length);
      this.sendResponse(id, { content });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to read file';
      this.logError('Failed to read file:', filePath, msg);
      this.sendErrorResponse(id, -32000, msg);
    }
  }

  /**
   * Handle fs/write_text_file request.
   */
  private handleWriteFile(id: number, params: { path: string; content?: string; text?: string }): void {
    const filePath = params.path;
    // Support both 'content' and 'text' parameter names
    const content = params.content ?? params.text;
    
    this.log('handleWriteFile params:', JSON.stringify(params));
    
    if (!content) {
      const msg = "params must have required property 'content' or 'text'";
      this.logError(msg);
      this.sendErrorResponse(id, -32602, msg);
      return;
    }
    
    // Security check: ensure path is within allowed directory
    if (!this.isPathAllowed(filePath)) {
      const msg = `Access denied: path "${filePath}" is outside the allowed directory`;
      this.logError(msg);
      this.sendErrorResponse(id, -32000, msg);
      return;
    }
    
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(filePath, content, 'utf-8');
      this.log('Wrote file:', filePath);
      this.sendResponse(id, { success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to write file';
      this.logError('Failed to write file:', filePath, msg);
      this.sendErrorResponse(id, -32000, msg);
    }
  }

  /**
   * Handle fs/list_directory request.
   */
  private handleListDirectory(id: number, params: { path: string }): void {
    const dirPath = params.path;
    
    // Security check: ensure path is within allowed directory
    if (!this.isPathAllowed(dirPath)) {
      const msg = `Access denied: path "${dirPath}" is outside the allowed directory`;
      this.logError(msg);
      this.sendErrorResponse(id, -32000, msg);
      return;
    }
    
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries.map((entry) => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      }));
      this.log('Listed directory:', dirPath, 'entries:', files.length);
      this.sendResponse(id, { entries: files });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to list directory';
      this.logError('Failed to list directory:', dirPath, msg);
      this.sendErrorResponse(id, -32000, msg);
    }
  }
}
