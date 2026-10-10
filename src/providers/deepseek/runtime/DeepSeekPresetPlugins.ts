import { parse, type ScalarTag, type SchemaOptions, stringify, YAMLError } from 'yaml';

import { type DeepSeekPreset, isDeepSeekAuxiliaryPreset } from '../types';

/** One native Cordis plugin row of an agent preset. */
export interface DeepSeekPresetPlugin {
  readonly id: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

/** Launch files the bundled compatibility plugin reads; the preview shows placeholders instead. */
export interface DeepSeekPresetPaths {
  readonly compatibility: string;
  readonly codeModeFile: string;
  promptFile(preset: DeepSeekPreset): string;
}

/**
 * dsh's entry-list dialect: JSON-typed YAML plus `!!js` expressions, which its loader evaluates from the same
 * `{ __jsExpr }` form in our JSON launch patch. JSON is valid input too.
 */
const JS_EXPRESSION: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: value => isJsExpression(value),
  resolve: source => ({ __jsExpr: source }),
  stringify: item => (item.value as { __jsExpr: string }).__jsExpr,
};
const YAML_OPTIONS: SchemaOptions = { schema: 'core', customTags: [JS_EXPRESSION] };

function isJsExpression(value: unknown): value is { __jsExpr: string } {
  return !!value && typeof value === 'object' && Object.keys(value).length === 1 && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string';
}

/** Rows reach native as JSON, so other YAML types (binary, timestamps, sets) are not rows dsh could load. */
function assertEntryValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertEntryValue(item, `${path}[${index}]`)); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertEntryValue(item, `${path}.${key}`);
    return;
  }
  throw new Error(`Unsupported YAML value at ${path}. Use plain YAML values or !!js expressions.`);
}

const PREVIEW_PATHS: DeepSeekPresetPaths = {
  compatibility: '<claudian-compatibility.mjs>', codeModeFile: '<code mode>', promptFile: () => '<system prompt>',
};

/**
 * Plugin rows of one Claudian preset. Both chat presets are identical (`claudian-code` is the legacy code-mode id),
 * and only they take the user's additional rows, after Claudian's own.
 */
export function buildDeepSeekPresetPlugins(
  preset: DeepSeekPreset, paths: DeepSeekPresetPaths, additional: readonly DeepSeekPresetPlugin[] = [],
): DeepSeekPresetPlugin[] {
  const auxiliary = isDeepSeekAuxiliaryPreset(preset);
  const allow = preset === 'claudian-passive' ? [] : ['read', 'read_image', 'glob', 'grep'];
  const plugin = (name: string, config?: unknown): DeepSeekPresetPlugin => ({
    id: name, name: `@deepseek-ai/dsh-${name}`, ...(config === undefined ? {} : { config }),
  });
  return [
    {
      id: 'claudian-compatibility', name: paths.compatibility,
      config: { promptFile: paths.promptFile(preset), ...(auxiliary ? { allow } : { codeModeFile: paths.codeModeFile }) },
    },
    // Chat presets present tools per agent from the live code-mode preference instead.
    ...(auxiliary ? [plugin('agent-tool-presentation', { mode: 'native' })] : []),
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
    ...(auxiliary ? [] : additional),
  ];
}

/** Every row id Claudian's chat preset declares, including rows nested in its groups. */
function ownRowIds(): Set<string> {
  const ids = new Set<string>();
  const visit = (rows: readonly unknown[]): void => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const { id, config } = row as { id?: unknown; config?: unknown };
      if (typeof id === 'string') ids.add(id);
      if (Array.isArray(config)) visit(config);
    }
  };
  visit(buildDeepSeekPresetPlugins('claudian', PREVIEW_PATHS));
  return ids;
}

/**
 * Parses the user's additional rows: a YAML list (dsh's dialect, so JSON too) of native plugin rows, each with its
 * own id and module name. Blank text means none. Throws an actionable message for anything else.
 */
export function parseDeepSeekPresetPlugins(text: string): DeepSeekPresetPlugin[] {
  let value: unknown;
  try { value = parse(text, YAML_OPTIONS); } catch (error) {
    if (!(error instanceof YAMLError)) throw error;
    const position = error.linePos?.[0];
    throw new Error(`Invalid YAML${position ? ` at line ${position.line}, column ${position.col}` : ''}: ${error.message.split('\n')[0]}`, { cause: error });
  }
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Additional plugins must be a YAML list of plugin rows.');
  assertEntryValue(value, 'rows');
  const own = ownRowIds();
  const seen = new Set<string>();
  return value.map((row: unknown, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Plugin row ${index + 1} must be an object.`);
    const { id, name } = row as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id.trim()) throw new Error(`Plugin row ${index + 1} needs a non-empty string "id".`);
    if (typeof name !== 'string' || !name.trim()) throw new Error(`Plugin row "${id}" needs a non-empty string "name" (the plugin module).`);
    if (own.has(id)) throw new Error(`Plugin row "${id}" is already part of Claudian's preset. Choose a different id.`);
    if (seen.has(id)) throw new Error(`Plugin row "${id}" appears more than once.`);
    seen.add(id);
    return row as DeepSeekPresetPlugin;
  });
}

/** The effective chat preset as it launches, with machine-specific launch paths shown as placeholders. */
export function renderDeepSeekPresetPreview(additional: readonly DeepSeekPresetPlugin[]): string {
  return stringify(buildDeepSeekPresetPlugins('claudian', PREVIEW_PATHS, additional), { ...YAML_OPTIONS, lineWidth: 0 });
}
