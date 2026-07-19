import * as fs from 'fs';
import * as https from 'https';
import { Notice } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { setUsageGuardBlock } from '../../../core/usageGuard/UsageGuardState';
import { getClaudeProviderSettings } from '../settings';

const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

interface UsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: UsageWindow;
}

function readAccessToken(): string | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function fetchUsage(token: string): Promise<UsageResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      USAGE_ENDPOINT,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Usage endpoint returned ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as UsageResponse);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Invalid usage response'));
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Usage check timed out'));
    });
    req.end();
  });
}

/**
 * Polls Claude's undocumented 5-hour usage endpoint every minute and blocks
 * new sends (via the shared, provider-neutral UsageGuardState) once
 * utilization reaches the configured threshold.
 *
 * Resuming is handled the same way as pausing: the next poll that reports
 * utilization back under the threshold clears the block. This covers the
 * 5-hour window reset without separately tracking `resets_at` timers.
 *
 * Fails open on any error (missing credentials, network failure, unexpected
 * response shape) so a transient issue with this undocumented endpoint never
 * blocks the user from sending messages.
 */
export class ClaudeUsageGuardService {
  private timer: number | null = null;
  private wasBlocked = false;
  private disposed = false;
  private readonly initialCheck: Promise<void>;

  constructor(private readonly plugin: ProviderHost) {
    this.initialCheck = this.tick();
    this.timer = window.setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Resolves once the first usage check has run (or the timeout elapses),
   * so callers that gate on workspace init can avoid a cold-start window
   * where a Claude account already over the threshold could still send one
   * message before the guard has any state to check.
   */
  async awaitInitialCheck(timeoutMs = 5_000): Promise<void> {
    await Promise.race([
      this.initialCheck,
      new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wasBlocked) {
      this.wasBlocked = false;
      setUsageGuardBlock(null);
    }
  }

  private async tick(): Promise<void> {
    const settings = getClaudeProviderSettings(
      this.plugin.settings,
    );

    if (!settings.usageGuardEnabled) {
      this.clearBlockIfNeeded();
      return;
    }

    const token = readAccessToken();
    if (!token) {
      // ponytail: no local Claude OAuth credentials to check against; fail open.
      this.clearBlockIfNeeded();
      return;
    }

    let usage: UsageResponse;
    try {
      usage = await fetchUsage(token);
    } catch {
      // Transient/API error on this undocumented endpoint (expired token,
      // network hiccup, endpoint change). Fail open rather than leaving the
      // user paused indefinitely; the next successful poll re-blocks if
      // usage is still over the threshold.
      this.clearBlockIfNeeded('Claudian resumed: could not confirm Claude usage, failing open.');
      return;
    }
    if (this.disposed) return;

    const utilization = usage.five_hour?.utilization;
    if (typeof utilization !== 'number') {
      this.clearBlockIfNeeded();
      return;
    }

    const isOverThreshold = utilization >= settings.usageGuardThresholdPercent;
    if (isOverThreshold) {
      this.blockIfNeeded(utilization, usage.five_hour?.resets_at);
    } else {
      this.clearBlockIfNeeded();
    }
  }

  private blockIfNeeded(utilization: number, resetsAt: string | undefined): void {
    if (this.wasBlocked) return;
    this.wasBlocked = true;

    const resetLabel = formatResetLabel(resetsAt);
    const percentLabel = Math.round(utilization);
    setUsageGuardBlock({
      reason: `Claudian is paused: Claude usage is at ${percentLabel}%. It will resume automatically after the 5-hour window resets${resetLabel}.`,
    });
    new Notice(`Claudian paused: Claude usage reached ${percentLabel}%. Resuming automatically${resetLabel}.`);
  }

  private clearBlockIfNeeded(
    message = 'Claudian resumed: Claude usage dropped below the guard threshold.',
  ): void {
    if (!this.wasBlocked) return;
    this.wasBlocked = false;
    setUsageGuardBlock(null);
    new Notice(message);
  }
}

function formatResetLabel(resetsAt: string | undefined): string {
  if (!resetsAt) return '';
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return '';
  return ` (around ${resetDate.toLocaleTimeString()})`;
}
