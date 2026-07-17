import { type ChildProcess,spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { getVaultPath } from '../../../utils/path';
import { getGrokProviderSettings, type GrokSafeMode } from '../settings';
import { buildGrokRuntimeEnv } from './GrokRuntimeEnvironment';

export interface GrokHeadlessRunOptions {
  cwd?: string;
  systemPrompt?: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onTextChunk?: (accumulated: string) => void;
  onSessionId?: (sessionId: string) => void;
  onProcess?: (proc: ChildProcess) => void;
}

export interface GrokHeadlessArgOptions {
  cwd: string;
  promptFile: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  permissionMode?: string;
  safeMode?: GrokSafeMode;
  systemRules?: string;
}

export function buildGrokHeadlessArgs(options: GrokHeadlessArgOptions): string[] {
  const args = [
    '--cwd',
    options.cwd,
    '--no-alt-screen',
    '--output-format',
    'streaming-json',
  ];

  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.systemRules) {
    args.push('--system-prompt-override', options.systemRules);
  }
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }
  if (options.permissionMode === 'yolo') {
    args.push('--always-approve');
  } else if (options.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan');
  } else if (options.safeMode) {
    args.push('--sandbox', options.safeMode);
  }

  args.push('--prompt-file', options.promptFile);
  return args;
}

export function writeGrokPromptFile(prompt: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `claudian-grok-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(filePath, prompt, 'utf-8');
  return filePath;
}

function readGrokString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readGrokString).filter(Boolean).join('');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.delta === 'string') {
    return record.delta;
  }
  if (typeof record.data === 'string') {
    return record.data;
  }
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (Array.isArray(record.data)) {
    return readGrokString(record.data);
  }
  if (record.data && typeof record.data === 'object') {
    return readGrokString(record.data);
  }
  if (Array.isArray(record.content)) {
    return readGrokString(record.content);
  }
  if (record.content && typeof record.content === 'object') {
    return readGrokString(record.content);
  }
  if (record.message) {
    return readGrokString(record.message);
  }
  if (record.update) {
    return readGrokString(record.update);
  }
  if (record.params) {
    return readGrokString(record.params);
  }
  if (record.result) {
    return readGrokString(record.result);
  }
  if (Array.isArray(record.choices)) {
    return readGrokString(record.choices);
  }
  if (typeof record.output_text === 'string') {
    return record.output_text;
  }
  if (typeof record.response === 'string') {
    return record.response;
  }
  return '';
}

export function extractGrokEventText(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (type.includes('error')) {
    return '';
  }

  const method = typeof record.method === 'string' ? record.method : '';
  if (method === 'session/update' || method === '_x.ai/session/update') {
    const params = record.params && typeof record.params === 'object'
      ? record.params as Record<string, unknown>
      : null;
    const update = params?.update && typeof params.update === 'object'
      ? params.update as Record<string, unknown>
      : null;
    const sessionUpdate = update && typeof update.sessionUpdate === 'string'
      ? update.sessionUpdate
      : '';
    if (sessionUpdate === 'agent_message_chunk') {
      return readGrokString(update?.content);
    }
    return '';
  }

  if (
    record.data !== undefined
    && (
      !type
      || type === 'text'
      || type === 'delta'
      || type.includes('message')
      || type.includes('chunk')
      || type.includes('output')
      || type.includes('response')
    )
  ) {
    return readGrokString(record.data);
  }
  if (record.delta !== undefined) {
    return readGrokString(record.delta);
  }
  if (record.text !== undefined) {
    return readGrokString(record.text);
  }
  if (record.content !== undefined) {
    return readGrokString(record.content);
  }
  if (record.message !== undefined) {
    return readGrokString(record.message);
  }
  if (record.update !== undefined) {
    return readGrokString(record.update);
  }
  if (record.params !== undefined) {
    return readGrokString(record.params);
  }
  if (record.result !== undefined) {
    return readGrokString(record.result);
  }
  if (record.output_text !== undefined) {
    return readGrokString(record.output_text);
  }
  if (record.response !== undefined) {
    return readGrokString(record.response);
  }
  return '';
}

export function extractGrokEventError(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }
  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (!type.includes('error') && record.error === undefined) {
    return '';
  }
  return readGrokString(record.message)
    || readGrokString(record.error)
    || readGrokString(record.params)
    || 'Grok returned an error';
}

export function extractGrokSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const record = event as Record<string, unknown>;
  const direct = record.session_id ?? record.sessionId ?? record.session ?? null;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  return extractGrokSessionId(record.params)
    || extractGrokSessionId(record.update)
    || extractGrokSessionId(record.result);
}

export function runGrokHeadless(
  plugin: ProviderHost,
  cliPath: string,
  prompt: string,
  options: GrokHeadlessRunOptions = {},
): Promise<string> {
  const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    plugin.settings,
    'grok',
  );
  const grokSettings = getGrokProviderSettings(settings);
  const cwd = options.cwd || getVaultPath(plugin.app) || process.cwd();
  const promptFile = writeGrokPromptFile(prompt);
  const args = buildGrokHeadlessArgs({
    cwd,
    promptFile,
    model: options.model || (typeof settings.model === 'string' ? settings.model : undefined),
    effort: options.effort || (typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined),
    sessionId: options.sessionId,
    permissionMode: typeof settings.permissionMode === 'string' ? settings.permissionMode : undefined,
    safeMode: grokSettings.safeMode,
    systemRules: options.systemPrompt,
  });
  const env = buildGrokRuntimeEnv(settings, cliPath);
  const proc = spawn(cliPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrText = '';
  let accumulated = '';
  let eventError = '';

  const appendText = (text: string): void => {
    if (!text) {
      return;
    }
    accumulated += text;
    options.onDelta?.(text);
    options.onTextChunk?.(accumulated);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const event = JSON.parse(trimmed) as unknown;
      const sessionId = extractGrokSessionId(event);
      if (sessionId) {
        options.onSessionId?.(sessionId);
      }
      const err = extractGrokEventError(event);
      if (err) {
        eventError = err;
        return;
      }
      appendText(extractGrokEventText(event));
    } catch {
      appendText(line.endsWith('\n') ? line : `${line}\n`);
    }
  };

  proc.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  proc.stderr.on('data', (chunk: Buffer | string) => {
    stderrText += chunk.toString('utf8');
  });

  const kill = (): void => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
      window.setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 1500);
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      kill();
    } else {
      options.signal.addEventListener('abort', kill, { once: true });
    }
  }

  options.onProcess?.(proc);

  return new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // ignore
      }
      reject(err);
    });

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer);
      }
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // ignore
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', kill);
      }
      if (options.signal?.aborted) {
        resolve(accumulated);
        return;
      }
      if (eventError) {
        reject(new Error(eventError));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(
          (stderrText.trim() || `Grok exited with code ${code}${signal ? ` (${signal})` : ''}`).trim(),
        ));
        return;
      }
      resolve(accumulated);
    });
  });
}
