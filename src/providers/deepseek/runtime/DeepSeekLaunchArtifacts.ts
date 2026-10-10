import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEEPSEEK_PRESETS, type DeepSeekPreset } from '../types';
import { DEEPSEEK_COMPATIBILITY_SOURCE, DEEPSEEK_EPHEMERAL_SOURCE, DEEPSEEK_LIFECYCLE_SOURCE } from './DeepSeekCompatibility';
import { buildDeepSeekPresetPlugins, type DeepSeekPresetPlugin } from './DeepSeekPresetPlugins';

/** Launch-only overlay for one shared Host: every Claudian preset, the lifecycle tether and ephemeral sessions. */
export interface DeepSeekLaunchArtifacts {
  readonly patchPath: string;
  /** Replaces a preset's literal prompt; native applies it at the next prompt assembly. */
  writePrompt(preset: DeepSeekPreset, text: string): Promise<void>;
  /** Chat agents read it at creation and at each turn start, so a change never lands mid-turn. */
  writeCodeMode(enabled: boolean): Promise<void>;
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
): Promise<DeepSeekLaunchArtifacts> {
  const root = await mkdtemp(join(directory, 'claudian-deepseek-'));
  const compatibilityPath = join(root, 'claudian-compatibility.mjs');
  const lifecyclePath = join(root, 'claudian-lifecycle.mjs');
  const promptPath = (preset: DeepSeekPreset): string => join(root, 'prompts', `${preset}.txt`);
  const codeModePath = join(root, 'code-mode');
  const ephemeralPath = join(root, 'claudian-ephemeral.mjs');
  const ephemeralStatePath = join(root, 'ephemeral-forks.json');
  const ephemeralReadyPath = join(root, 'ephemeral-ready.json');
  const ephemeralSpillPath = join(root, 'spill');
  const patchPath = join(root, 'claudian.patch.json');
  const written = new Map<string, string>();
  let writes = Promise.resolve();
  let temporaries = 0;
  const replace = (path: string, text: string): Promise<void> => {
    // Serialize writes and replace atomically so native never reads a partial file.
    const task = writes.then(async () => {
      if (written.get(path) === text) return;
      const temporary = `${path}.${temporaries++}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, path);
      written.set(path, text);
    });
    writes = task.catch(() => {});
    return task;
  };
  const writePrompt = (preset: DeepSeekPreset, text: string): Promise<void> => replace(promptPath(preset), text);
  const writeCodeMode = (enabled: boolean): Promise<void> => replace(codeModePath, enabled ? 'both' : 'native');
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
      return ready.protocol === 1 && ready.persistence === true && ready.projectionGuard === true && ready.workspaceGuard === true
        && ready.spillGuard === true;
    } catch { return false; }
  };
  const paths = { compatibility: compatibilityPath, codeModeFile: codeModePath, promptFile: promptPath };
  try {
    await mkdir(join(root, 'prompts'), { mode: 0o700 });
    const patch = [
      { id: 'config-editor', disabled: true },
      { id: 'settings', disabled: true },
      { id: 'hmr', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { insert: [
        { id: 'claudian-lifecycle', name: lifecyclePath },
        ...DEEPSEEK_PRESETS.map(preset => ({
          id: `preset-${preset}`, name: '@deepseek-ai/dsh-agent-preset',
          config: { id: preset, name: 'Claudian', plugins: buildDeepSeekPresetPlugins(preset, paths, presetPlugins) },
        })),
      ] },
      { insert: [{ id: 'claudian-ephemeral', name: ephemeralPath, config: { stateFile: ephemeralStatePath, readyFile: ephemeralReadyPath, spillRoot: ephemeralSpillPath } }] },
    ];
    await Promise.all([
      writeFile(compatibilityPath, DEEPSEEK_COMPATIBILITY_SOURCE, { mode: 0o600 }),
      writeFile(lifecyclePath, DEEPSEEK_LIFECYCLE_SOURCE, { mode: 0o600 }),
      writeFile(ephemeralPath, DEEPSEEK_EPHEMERAL_SOURCE, { mode: 0o600 }),
      writeOffers(),
      writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 }),
      ...DEEPSEEK_PRESETS.map(preset => writePrompt(preset, '')),
      writeCodeMode(false),
    ]);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { patchPath, writePrompt, writeCodeMode, offerEphemeralFork, readEphemeralReady, dispose: () => rm(root, { recursive: true, force: true }) };
}
