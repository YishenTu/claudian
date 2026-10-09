import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEEPSEEK_PRESETS, type DeepSeekPreset } from '../types';
import { DEEPSEEK_COMPATIBILITY_SOURCE, DEEPSEEK_LIFECYCLE_SOURCE } from './DeepSeekCompatibility';

interface NativePlugin {
  id: string;
  name: string;
  config?: unknown;
  group?: boolean;
  isolate?: Record<string, boolean>;
}

/** Launch-only overlay for one shared Host: every Claudian preset plus the lifecycle tether. */
export interface DeepSeekLaunchArtifacts {
  readonly patchPath: string;
  /** Replaces a preset's literal prompt; native applies it at the next prompt assembly. */
  writePrompt(preset: DeepSeekPreset, text: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function prepareDeepSeekLaunchArtifacts(directory = tmpdir()): Promise<DeepSeekLaunchArtifacts> {
  const root = await mkdtemp(join(directory, 'claudian-deepseek-'));
  const compatibilityPath = join(root, 'claudian-compatibility.mjs');
  const lifecyclePath = join(root, 'claudian-lifecycle.mjs');
  const promptPath = (preset: DeepSeekPreset): string => join(root, 'prompts', `${preset}.txt`);
  const patchPath = join(root, 'claudian.patch.json');
  const written = new Map<DeepSeekPreset, string>();
  let writes = Promise.resolve();
  const writePrompt = (preset: DeepSeekPreset, text: string): Promise<void> => {
    // Serialize writes and replace atomically so native assembly never reads a partial prompt.
    const task = writes.then(async () => {
      if (written.get(preset) === text) return;
      const temporary = `${promptPath(preset)}.${written.size}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, promptPath(preset));
      written.set(preset, text);
    });
    writes = task.catch(() => {});
    return task;
  };
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
          config: { id: preset, name: 'Claudian', plugins: buildPlugins(preset, compatibilityPath, promptPath(preset)) },
        })),
      ] },
    ];
    await Promise.all([
      writeFile(compatibilityPath, DEEPSEEK_COMPATIBILITY_SOURCE, { mode: 0o600 }),
      writeFile(lifecyclePath, DEEPSEEK_LIFECYCLE_SOURCE, { mode: 0o600 }),
      writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 }),
      ...DEEPSEEK_PRESETS.map(preset => writePrompt(preset, '')),
    ]);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { patchPath, writePrompt, dispose: () => rm(root, { recursive: true, force: true }) };
}

function buildPlugins(preset: DeepSeekPreset, compatibilityPath: string, promptFile: string): NativePlugin[] {
  const auxiliary = preset === 'claudian-passive' || preset === 'claudian-read-only';
  const allow = preset === 'claudian-passive' ? [] : ['read', 'read_image', 'glob', 'grep'];
  const plugin = (name: string, config?: unknown): NativePlugin => ({
    id: name, name: `@deepseek-ai/dsh-${name}`, ...(config === undefined ? {} : { config }),
  });
  return [
    { id: 'claudian-compatibility', name: compatibilityPath, config: { promptFile, ...(auxiliary ? { allow } : {}) } },
    plugin('agent-tool-presentation', { mode: preset === 'claudian-code' ? 'both' : 'native' }),
    plugin('agent-instructions', { maxBytes: 65536 }),
    plugin('time-context'),
    plugin('tool-fs'),
    plugin('tool-fs-search', { sampleOverCapGlobResults: false }),
    ...(!auxiliary ? [
      plugin('tool-bash'),
      plugin('tool-jobs'),
      plugin('skill-filesystem'),
      plugin('tool-skill'),
      plugin('tool-subagent-control'),
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      plugin('tool-subagent', { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable', modelSelectionSettings: false }),
      { ...plugin('tool-subagent', { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable', modelSelectionSettings: false }), id: 'tool-subagent-fork' },
      plugin('tool-ask-user'),
      plugin('tool-web', { fetch: true, searchTimeoutMs: 60000 }),
    ] : []),
    {
      id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        plugin('compaction-basic'), plugin('command-compact'),
        plugin('compaction-tool-result-pruner', { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }),
      ],
    },
  ];
}
