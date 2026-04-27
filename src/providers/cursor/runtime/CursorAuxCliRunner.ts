import { spawn } from 'child_process';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { buildCursorAgentEnvironment } from './cursorAgentEnv';
import { resolveCursorModelForCli } from './cursorCliModel';
import { buildCursorAgentJsonModeFlagArgs, type CursorPermissionMode } from './cursorLaunchArgs';

export interface CursorAuxQueryConfig {
  systemPrompt: string;
  model?: string;
  abortController?: AbortController;
}

interface CursorJsonResult {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

export class CursorAuxCliRunner {
  private sessionId: string | null = null;

  constructor(private readonly plugin: ClaudianPlugin) {}

  reset(): void {
    this.sessionId = null;
  }

  async query(config: CursorAuxQueryConfig, prompt: string): Promise<string> {
    const cli = this.plugin.getResolvedProviderCliPath('cursor');
    if (!cli) {
      throw new Error('Cursor Agent CLI not found. Install the Cursor CLI and configure its path in settings.');
    }

    const workspaceDir = getVaultPath(this.plugin.app) ?? process.cwd();
    const permissionMode = this.plugin.settings.permissionMode as CursorPermissionMode;
    const model = resolveCursorModelForCli(
      config.model ?? this.resolveProviderModel(),
    );

    const flagArgs = buildCursorAgentJsonModeFlagArgs({
      workspaceDir,
      model,
      permissionMode,
      resumeSessionId: this.sessionId,
    });

    const fullPrompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${prompt}`
      : prompt;

    const env = buildCursorAgentEnvironment(this.plugin);
    const { stdout, stderr, code, signal } = await this.spawnOnce(
      cli,
      [...flagArgs, fullPrompt],
      { cwd: workspaceDir, env },
      config.abortController?.signal,
    );

    if (signal === 'SIGTERM' || config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    if (code !== 0) {
      throw new Error(stderr.trim() || `Cursor Agent exited with code ${code}`);
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Empty response from Cursor Agent');
    }

    let parsed: CursorJsonResult;
    try {
      parsed = JSON.parse(trimmed) as CursorJsonResult;
    } catch {
      throw new Error('Failed to parse Cursor Agent JSON output');
    }

    if (typeof parsed.session_id === 'string' && parsed.session_id) {
      this.sessionId = parsed.session_id;
    }

    if (parsed.is_error === true) {
      throw new Error(parsed.result?.trim() || 'Cursor Agent reported an error');
    }

    return typeof parsed.result === 'string' ? parsed.result : '';
  }

  private resolveProviderModel(): string | undefined {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'cursor',
    );
    const m = providerSettings.model;
    return typeof m === 'string' && m.trim() ? m.trim() : undefined;
  }

  private spawnOnce(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.on('error', (err) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(err);
      });

      child.on('close', (code, killSignal) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve({ stdout, stderr, code, signal: killSignal });
      });
    });
  }
}
