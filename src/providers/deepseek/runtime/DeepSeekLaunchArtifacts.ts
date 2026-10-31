import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ExecutionPathMapper } from '@/core/process/execution-target/types';
import type { SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';

import { DEEPSEEK_PRESETS } from '../types';
import { DEEPSEEK_COMPATIBILITY_SOURCE, DEEPSEEK_EPHEMERAL_SOURCE, DEEPSEEK_LIFECYCLE_SOURCE, DEEPSEEK_SESSIONS_SOURCE } from './DeepSeekCompatibility';
import { buildDeepSeekPresetPlugins, type DeepSeekPresetPlugin } from './DeepSeekPresetPlugins';

/** Launch-only overlay for one shared Host: every Claudian preset, the lifecycle tether and ephemeral sessions. */
export interface DeepSeekLaunchArtifacts {
  readonly patchPath: string;
  readonly desktopRunnerPath: string;
  /** Replaces one native session's literal prompt; native applies it from that session's next turn. */
  writePrompt(sessionId: string, text: string): Promise<void>;
  /** Removes a released session's prompt; a turn already running keeps the prompt it started with. */
  removePrompt(sessionId: string): Promise<void>;
  /** Chat agents read it at creation and at each turn start, so a change never lands mid-turn. */
  writeCodeMode(enabled: boolean): Promise<void>;
  /** Atomically publishes an endpoint replacement without restarting the native Host. */
  writeSessionToolRoute(route: Pick<SessionToolRoute, 'url' | 'routeId'>): Promise<void>;
  /**
   * Makes the next native fork of `parent` at `atSeq` ephemeral until the returned withdrawal runs. Callers serialize
   * forks so no other fork of the same parent can claim it.
   */
  offerEphemeralFork(parent: string, atSeq: number): Promise<() => Promise<void>>;
  /** Whether the bundled ephemeral plugin reported every guard in place; read after native startup. */
  readEphemeralReady(): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function prepareDeepSeekLaunchArtifacts(
  directory = tmpdir(), presetPlugins: readonly DeepSeekPresetPlugin[] = [],
  sessionToolRoute?: Pick<SessionToolRoute, 'url' | 'routeId'>,
  pathMapper?: ExecutionPathMapper,
): Promise<DeepSeekLaunchArtifacts> {
  const root = await mkdtemp(join(directory, 'claudian-deepseek-'));
  const compatibilityPath = join(root, 'claudian-compatibility.mjs');
  const sessionsPath = join(root, 'claudian-sessions.mjs');
  const sessionToolsFile = join(root, 'session-tools.json');
  const lifecyclePath = join(root, 'claudian-lifecycle.mjs');
  const promptDirectory = join(root, 'prompts');
  const promptPath = (sessionId: string): string => join(promptDirectory, deepseekPromptFileName(sessionId));
  const codeModePath = join(root, 'code-mode');
  const ephemeralPath = join(root, 'claudian-ephemeral.mjs');
  const ephemeralStatePath = join(root, 'ephemeral-forks.json');
  const ephemeralReadyPath = join(root, 'ephemeral-ready.json');
  const ephemeralSpillPath = join(root, 'spill');
  const ephemeralAttachmentPath = join(root, 'attachments');
  const patchPath = join(root, 'claudian.patch.json');
  const desktopRunnerPath = join(root, 'desktop-runner.mjs');
  const written = new Map<string, string>();
  let writes = Promise.resolve();
  const replace = (path: string, text: string): Promise<void> => {
    // Serialize writes and replace atomically so native never reads a partial file.
    const task = writes.then(async () => {
      if (written.get(path) === text) return;
      const temporary = `${path}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await replaceFile(temporary, path);
      written.set(path, text);
    });
    writes = task.catch(() => {});
    return task;
  };
  const remove = (path: string): Promise<void> => {
    const task = writes.then(async () => {
      await rm(path, { force: true, maxRetries: 5 });
      written.delete(path);
    });
    writes = task.catch(() => {});
    return task;
  };
  const writePrompt = (sessionId: string, text: string): Promise<void> => replace(promptPath(sessionId), text);
  const removePrompt = (sessionId: string): Promise<void> => remove(promptPath(sessionId));
  const writeCodeMode = (enabled: boolean): Promise<void> => replace(codeModePath, enabled ? 'both' : 'native');
  const writeSessionToolRoute = (route: Pick<SessionToolRoute, 'url' | 'routeId'>): Promise<void> =>
    replace(sessionToolsFile, JSON.stringify({ url: route.url, routeId: route.routeId }));
  const offers = new Map<string, { parent: string; atSeq: number; token: string }>();
  const writeOffers = (): Promise<void> => replace(ephemeralStatePath, JSON.stringify({ forks: [...offers.values()] }));
  const offerEphemeralFork = async (parent: string, atSeq: number): Promise<() => Promise<void>> => {
    const token = randomUUID();
    offers.set(token, { parent, atSeq, token });
    // An unpublished offer has no withdrawal, so it must not reach a later write.
    try { await writeOffers(); } catch (error) { offers.delete(token); throw error; }
    return () => { offers.delete(token); return writeOffers(); };
  };
  const readEphemeralReady = async (): Promise<boolean> => {
    try {
      const ready = JSON.parse(await readFile(ephemeralReadyPath, 'utf8')) as Record<string, unknown>;
      return ready.persistence === true && ready.projectionGuard === true && ready.workspaceGuard === true
        && ready.spillGuard === true && ready.attachmentGuard === true;
    } catch { return false; }
  };
  const targetPath = (path: string): string => {
    if (!pathMapper || pathMapper.target.method !== 'wsl') return path;
    const mapped = pathMapper.toTargetPath(path);
    if (!mapped) throw new Error('DeepSeek launch files must be accessible inside the selected WSL distro.');
    return mapped;
  };
  const platform = pathMapper?.target.platformOs === 'linux' ? 'linux' : process.platform;
  try {
    const paths = { sessions: targetPath(sessionsPath), sessionToolsFile: targetPath(sessionToolsFile), compatibility: targetPath(compatibilityPath), codeModeFile: targetPath(codeModePath), promptDirectory: targetPath(promptDirectory) };
    await mkdir(promptDirectory, { mode: 0o700 });
    const patch = [
      { id: 'config-editor', disabled: true },
      { id: 'settings', disabled: true },
      { id: 'hmr', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { insert: [
        { id: 'claudian-lifecycle', name: targetPath(lifecyclePath) },
        ...DEEPSEEK_PRESETS.map(preset => ({
          id: `preset-${preset}`, name: '@deepseek-ai/dsh-agent-preset',
          config: { id: preset, name: 'Claudian', plugins: buildDeepSeekPresetPlugins(preset, paths, presetPlugins, platform).map(row => anchorModuleName(row, platform)) },
        })),
      ] },
      { insert: [{ id: 'claudian-ephemeral', name: targetPath(ephemeralPath), config: { stateFile: targetPath(ephemeralStatePath), readyFile: targetPath(ephemeralReadyPath), spillRoot: targetPath(ephemeralSpillPath), attachmentRoot: targetPath(ephemeralAttachmentPath) } }] },
    ];
    await Promise.all([
      replace(sessionsPath, DEEPSEEK_SESSIONS_SOURCE),
      sessionToolRoute ? writeSessionToolRoute(sessionToolRoute) : replace(sessionToolsFile, '{}'),
      writeFile(compatibilityPath, DEEPSEEK_COMPATIBILITY_SOURCE, { mode: 0o600 }),
      writeFile(lifecyclePath, DEEPSEEK_LIFECYCLE_SOURCE, { mode: 0o600 }),
      writeFile(ephemeralPath, DEEPSEEK_EPHEMERAL_SOURCE, { mode: 0o600 }),
      writeOffers(),
      writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 }),
      writeFile(desktopRunnerPath, DESKTOP_RUNNER_SOURCE, { mode: 0o600 }),
      writeCodeMode(false),
    ]);
  } catch (error) {
    await removeRoot(root);
    throw error;
  }
  return { patchPath, desktopRunnerPath, writeSessionToolRoute, writePrompt, removePrompt, writeCodeMode, offerEphemeralFork, readEphemeralReady, dispose: () => removeRoot(root) };
}

/** Native session ids are not file names on every platform; the compatibility plugin derives the same name. */
function deepseekPromptFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.txt`;
}

/**
 * Native converts absolute `insert` row names (and their group children) to file URLs, but imports names nested in a
 * preset's `plugins` literally, where a Windows drive letter reads as a URL scheme and `#` as a fragment.
 */
function anchorModuleName<Row extends { readonly name?: unknown; readonly group?: unknown; readonly config?: unknown }>(row: Row, platform: NodeJS.Platform): Row {
  const name = typeof row.name === 'string' && (platform === 'linux' ? row.name.startsWith('/') : isAbsolute(row.name)) ? pathToFileURL(row.name, { windows: platform === 'win32' }).href : row.name;
  return { ...row, name, ...(row.group && Array.isArray(row.config) ? { config: row.config.map(child => anchorModuleName(child as Record<string, unknown>, platform)) } : {}) };
}

// Windows refuses a replacement or removal while a reader, scanner or exiting Host briefly holds a file.
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function replaceFile(temporary: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(temporary, path); } catch (error) {
      if (attempt >= 5 || !TRANSIENT_LOCK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => window.setTimeout(resolve, 20 * attempt));
    }
  }
}

function removeRoot(root: string): Promise<void> { return rm(root, { recursive: true, force: true, maxRetries: 5 }); }

// Desktop reserves its profile in the CLI. Use the same exported runner as Desktop, under its own Electron.
// Resolve from the installed package inside ASAR so profile-local bundles and native dependencies retain their owners.
const DESKTOP_RUNNER_SOURCE = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [installAnchor, directory, patch] = process.argv.slice(2);
const installed = createRequire(installAnchor);
const { loadLayeredEnv, loadProfileDirectory } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-app-boot')).href);
const { runProfile } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh/profile-boot')).href);
const profile = loadProfileDirectory('dsh', directory, installAnchor);
await runProfile({
  environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: { profile, installAnchor },
  patchFiles: [patch], args: ['--no-open', '--port', '0'],
});
`;
