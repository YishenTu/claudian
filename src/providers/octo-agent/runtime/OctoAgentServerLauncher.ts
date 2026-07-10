import { spawn } from 'node:child_process';

import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { getOctoAgentProviderSettings } from '../settings';
import { resolveOctoAgentBinary } from './OctoAgentBinaryLocator';

const OBSIDIAN_ORIGIN = 'app://obsidian.md';
const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_POLL_TIMEOUT_MS = 15_000;

export interface OctoAgentServerLauncherOptions {
  plugin: ClaudianPlugin;
}

export interface OctoAgentServerProbeResult {
  running: boolean;
}

export async function probeOctoAgentServer(baseUrl: string, accessKey?: string): Promise<OctoAgentServerProbeResult> {
  try {
    const suffix = accessKey ? `?access_key=${encodeURIComponent(accessKey)}` : '';
    const response = await fetch(`${baseUrl}/api/health${suffix}`, {
      method: 'GET',
    });
    return { running: response.ok };
  } catch {
    return { running: false };
  }
}

async function waitForServer(baseUrl: string, accessKey: string | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { running } = await probeOctoAgentServer(baseUrl, accessKey);
    if (running) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function parseEnvString(envText: string): Record<string, string> {
  return parseEnvironmentVariables(envText);
}

export async function ensureOctoAgentServerRunning(options: OctoAgentServerLauncherOptions): Promise<boolean> {
  const { plugin } = options;
  const settingsBag = plugin.settings as unknown as Record<string, unknown>;
  const settings = getOctoAgentProviderSettings(settingsBag);

  if (!settings.enabled) {
    return false;
  }

  const baseUrl = `http://${settings.host}:${settings.port}`;
  const accessKey = settings.accessKey || undefined;
  const probe = await probeOctoAgentServer(baseUrl, accessKey);
  if (probe.running) {
    return true;
  }

  if (!settings.autoStartServer) {
    return false;
  }

  const cliPathInput = settings.cliPath.trim();
  const resolvedBinary = resolveOctoAgentBinary(cliPathInput) ?? (cliPathInput || 'octo');
  const args = ['serve', '-d', '--cors', OBSIDIAN_ORIGIN];

  if (accessKey) {
    args.push('--access-key', accessKey);
  }

  const cwd = getVaultPath(plugin.app) ?? undefined;
  const customEnv = parseEnvString(settings.environmentVariables);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...customEnv,
    PATH: getEnhancedPath(process.env.PATH, resolvedBinary),
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const proc = spawn(resolvedBinary, args, {
      cwd,
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: true,
    });

    proc.on('error', (error) => {
      console.error('Failed to start octo serve:', error);
      settle(false);
    });

    proc.on('exit', (code, signal) => {
      if (code !== 0 && signal === null) {
        console.error(`octo serve exited with code ${String(code)}`);
      }
    });

    proc.unref();

    // Daemon mode (-d) should fork into the background quickly; give it a moment
    // before we start polling the health endpoint.
    window.setTimeout(async () => {
      const running = await waitForServer(baseUrl, accessKey, HEALTH_POLL_TIMEOUT_MS);
      if (!running) {
        console.error('octo serve did not become ready after auto-start');
      }
      settle(running);
    }, 300);
  });
}
