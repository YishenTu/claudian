/**
 * UsageLimitsService - fetches account-level usage limits (5-hour session
 * and weekly windows) from the Anthropic OAuth usage endpoint, using the
 * Claude Code credentials already present on the machine.
 *
 * The OAuth access token is read from the OS credential store:
 * - macOS: Keychain entry "Claude Code-credentials"
 * - Linux/Windows: ~/.claude/.credentials.json
 *
 * The token never leaves the machine except toward the official
 * api.anthropic.com endpoint, and is never logged or displayed.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { requestUrl } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_TTL_MS = 60_000;

export interface UsageLimitWindow {
  /** Percentage used, 0-100. */
  utilization: number;
  /** ISO timestamp at which the window resets, or null when unknown. */
  resetsAt: string | null;
}

export interface AccountUsageLimits {
  /** 5-hour rolling session window. */
  session: UsageLimitWindow | null;
  /** 7-day window across all models. */
  weekly: UsageLimitWindow | null;
  /** 7-day model-scoped window (e.g. Opus), when reported. */
  weeklyScoped: UsageLimitWindow | null;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
}

interface RawLimitEntry {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  is_active?: boolean;
}

interface RawUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
  limits?: RawLimitEntry[] | null;
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseAccessToken(credentialsJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(credentialsJson);
    if (parsed && typeof parsed === 'object') {
      const oauth = (parsed as Record<string, unknown>)['claudeAiOauth'];
      if (oauth && typeof oauth === 'object') {
        const token = (oauth as Record<string, unknown>)['accessToken'];
        if (typeof token === 'string' && token.length > 0) {
          return token;
        }
      }
    }
  } catch {
    // fallthrough
  }
  return null;
}

async function readTokenFromKeychain(): Promise<string | null> {
  try {
    const stdout = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    return parseAccessToken(stdout.trim());
  } catch {
    return null;
  }
}

async function readTokenFromCredentialsFile(): Promise<string | null> {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const contents = await fs.readFile(credentialsPath, 'utf8');
    return parseAccessToken(contents);
  } catch {
    return null;
  }
}

function toWindow(
  raw: { utilization?: number; resets_at?: string | null } | null | undefined,
): UsageLimitWindow | null {
  if (!raw || typeof raw.utilization !== 'number' || isNaN(raw.utilization)) {
    return null;
  }
  return {
    utilization: Math.min(100, Math.max(0, Math.round(raw.utilization))),
    resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
  };
}

function extractScopedWeekly(limits: RawLimitEntry[] | null | undefined): UsageLimitWindow | null {
  if (!Array.isArray(limits)) {
    return null;
  }
  const scoped = limits.find(
    (entry) => entry.kind === 'weekly_scoped' && typeof entry.percent === 'number',
  );
  if (!scoped) {
    return null;
  }
  return toWindow({ utilization: scoped.percent, resets_at: scoped.resets_at ?? null });
}

export class UsageLimitsService {
  private cache: AccountUsageLimits | null = null;
  private inflight: Promise<AccountUsageLimits> | null = null;

  /**
   * Fetch account usage limits. Results are cached for a short TTL and
   * concurrent callers share a single in-flight request.
   */
  async getLimits(forceRefresh = false): Promise<AccountUsageLimits> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache;
    }
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.fetchLimits()
      .then((limits) => {
        this.cache = limits;
        return limits;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  /** Latest cached snapshot, if any (no network). */
  getCached(): AccountUsageLimits | null {
    return this.cache;
  }

  private async resolveToken(): Promise<string> {
    const token =
      process.platform === 'darwin'
        ? (await readTokenFromKeychain()) ?? (await readTokenFromCredentialsFile())
        : (await readTokenFromCredentialsFile()) ?? (await readTokenFromKeychain());

    if (!token) {
      throw new Error('credentials-not-found');
    }
    return token;
  }

  private async fetchLimits(): Promise<AccountUsageLimits> {
    const token = await this.resolveToken();

    const response = await requestUrl({
      url: USAGE_ENDPOINT,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'Content-Type': 'application/json',
      },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`usage-request-failed:${response.status}`);
    }

    const raw = response.json as RawUsageResponse;

    return {
      session: toWindow(raw.five_hour),
      weekly: toWindow(raw.seven_day),
      weeklyScoped: extractScopedWeekly(raw.limits),
      fetchedAt: Date.now(),
    };
  }
}

/** Shared singleton — usage limits are account-wide, not per-tab. */
export const usageLimitsService = new UsageLimitsService();
