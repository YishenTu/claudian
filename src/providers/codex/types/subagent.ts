export interface CodexSubagentDefinition {
  name: string;
  description: string;
  developerInstructions: string;
  nicknameCandidates?: string[];
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
  filePath?: string;
  /** Preserves unrecognized TOML keys for round-trip fidelity. */
  extraFields?: Record<string, unknown>;
}

export const CODEX_SUBAGENT_KNOWN_KEYS = new Set([
  'name',
  'description',
  'developer_instructions',
  'nickname_candidates',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
]);
