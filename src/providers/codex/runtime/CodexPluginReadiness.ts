import type { SkillsListResult } from './codexAppServerTypes';
import type { CodexRPCTransport } from './CodexRPCTransport';

const PLUGIN_STARTUP_TIMEOUT_MS = 30_000;

interface InstalledPluginsResult {
  marketplaces: Array<{
    plugins: Array<{
      id: string;
      installed: boolean;
      enabled: boolean;
      availability?: string;
      interface?: { capabilities: string[] } | null;
    }>;
  }>;
}

/** Warm the installed-plugin snapshot before a thread or skill catalog captures it. */
export async function waitForCodexPluginReadiness(
  transport: CodexRPCTransport,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const deadline = Date.now() + PLUGIN_STARTUP_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  try {
    // Unlike app/installed, this populates the remote installed-plugin catalog
    // consumed by plugin loading. It can return while bundle sync is still running.
    const installed = await transport.request<InstalledPluginsResult>(
      'plugin/installed', { cwds: [cwd] }, remaining(),
    );
    signal.throwIfAborted();
    const expected = new Set(installed.marketplaces.flatMap(marketplace => (
      marketplace.plugins.filter(plugin => (
        plugin.installed && plugin.enabled
        && (!plugin.availability || plugin.availability === 'AVAILABLE')
        && plugin.interface?.capabilities.includes('skills')
      )).map(plugin => plugin.id)
    )));
    if (!expected.size) return;

    // 0.160.0 has no startup-ready notification; skills/changed only reports
    // filesystem changes. Observe the actual plugin skills rather than elapsed time.
    let delayMs = 100;
    while (Date.now() < deadline) {
      const result = await transport.request<SkillsListResult>(
        'skills/list', { cwds: [cwd], forceReload: true }, remaining(),
      );
      signal.throwIfAborted();
      const loaded = new Set(result.data.filter(entry => entry.cwd === cwd).flatMap(entry => (
        entry.skills.map(skill => skill.pluginId)
      )));
      if ([...expected].every(id => loaded.has(id))) return;
      await waitForRetry(Math.min(delayMs, remaining()), signal);
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  } catch {
    signal.throwIfAborted();
    // Older CLIs, offline catalogs and timeouts retain the previous behavior.
    // The caller still owns transport errors and process lifetime on its next RPC.
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = window.setTimeout(finish, delayMs);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Codex plugin startup cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
