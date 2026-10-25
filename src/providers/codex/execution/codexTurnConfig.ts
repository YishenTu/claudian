import type { ProviderExecutionRequest } from '@/core/execution';
import { buildContextFromHistory } from '@/core/prompt/historyContext';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { buildRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import type { ProviderRuntimeHost, ProviderSelectionDefaults } from '@/core/providers/ProviderRuntimeHost';
import type { ChatMessage } from '@/core/types';
import { type CodexProviderSettings, type CodexSafeMode, decodeCodexConfig } from '@/providers/codex/config';
import { getCodexModelOptions } from '@/providers/codex/modelOptions';
import {
  findCodexModel,
  getCodexReasoningEffortOptions,
  resolveCodexModelServiceTier,
  resolveCodexReasoningEffort,
} from '@/providers/codex/models';
import { toCodexRuntimeModelId } from '@/providers/codex/modelSelection';
import type { ConfigReadResult, SandboxPolicy } from '@/providers/codex/runtime/codexAppServerTypes';

/** Resolves a turn's native configuration: model, effort, approval and sandbox policy, and prompt. */

const PASSIVE_INSTRUCTIONS =
  'Do not invoke tools. Complete the request only from the supplied input and context.';

/** Turn fallbacks for request fields left unset: Codex's saved preference, then the current selection. */
export function resolveCodexTurnSelection(
  host: Pick<ProviderRuntimeHost, 'savedSelection' | 'selection'>,
): ProviderSelectionDefaults {
  const { savedSelection: saved, selection: current } = host;
  return {
    model: saved.model ?? current.model,
    effortLevel: saved.effortLevel ?? current.effortLevel,
    serviceTier: saved.serviceTier ?? current.serviceTier,
    permissionMode: saved.permissionMode ?? current.permissionMode,
  };
}

export interface CodexPolicy {
  readonly approvalPolicy: string;
  readonly approvalsReviewer: string;
  readonly sandbox: string;
  /** Config-independent policy; config-derived modes leave the policy to Codex. */
  readonly sandboxPolicy?: SandboxPolicy;
}

/** The inputs a Codex turn resolves against when its request leaves a field unset. */
export interface CodexTurnSettings {
  readonly codex: CodexProviderSettings;
  /** Saved Codex preferences, else the current selections. */
  readonly selection: ProviderSelectionDefaults;
}

export function resolveCodexTurnSettings(
  config: Readonly<Record<string, unknown>>,
  selection: ProviderSelectionDefaults,
): CodexTurnSettings {
  return { codex: decodeCodexConfig(config), selection };
}

/** The runtime model ID of an enabled selection, or null when none is usable. */
export function resolveCodexTurnModel(
  request: ProviderExecutionRequest,
  settings: CodexTurnSettings,
): string | null {
  const selected = normalizeString(request.configuration.model)
    ?? normalizeString(settings.selection.model);
  if (!selected) return null;
  const runtimeModel = toCodexRuntimeModelId(selected);
  const enabled = getCodexModelOptions(settings.codex).some(
    option => toCodexRuntimeModelId(option.value) === runtimeModel,
  );
  return enabled ? runtimeModel : null;
}

export function resolveCodexTurnReasoningEffort(
  request: ProviderExecutionRequest,
  settings: CodexTurnSettings,
  model: string,
): string | null {
  if (request.configuration.reasoning === null) return null;
  const codexSettings = settings.codex;
  const modelMetadata = findCodexModel(codexSettings.discoveredModels, model);
  const effort = resolveCodexReasoningEffort(
    modelMetadata,
    codexSettings.enableUltraEffort,
    normalizeString(request.configuration.reasoning)
      ?? normalizeString(settings.selection.effortLevel),
  );
  if (request.configuration.reasoning !== undefined && (effort !== request.configuration.reasoning
    || (modelMetadata && !getCodexReasoningEffortOptions(modelMetadata, codexSettings.enableUltraEffort)
      .some(option => option.value === request.configuration.reasoning)))) {
    throw new Error(`Codex model "${model}" does not support reasoning effort "${request.configuration.reasoning}".`);
  }
  if (!effort) {
    throw new Error(`Codex model "${model}" has no enabled reasoning efforts.`);
  }
  return effort;
}

export function resolveCodexServiceTier(
  request: ProviderExecutionRequest,
  modelId: string,
  settings: CodexTurnSettings,
): string | null {
  const model = findCodexModel(settings.codex.discoveredModels, modelId);
  return resolveCodexModelServiceTier(model, request.configuration.serviceTier ?? settings.selection.serviceTier);
}

export function resolveCodexBaseInstructions(request: ProviderExecutionRequest): string {
  const base = request.configuration.systemInstructions.instructions;
  return request.toolPolicy.kind === 'passive'
    ? `${base}\n\n${PASSIVE_INSTRUCTIONS}`
    : base;
}

export function resolveCodexTurnPolicy(
  request: ProviderExecutionRequest,
  settings: CodexTurnSettings,
): CodexPolicy {
  const toolPolicy = request.toolPolicy;
  if (toolPolicy.kind === 'passive' || toolPolicy.kind === 'read-only' || toolPolicy.kind === 'allow-list') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      sandboxPolicy: strictReadOnlySandbox(),
    };
  }
  if (toolPolicy.kind === 'unrestricted') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
  }

  const permissionMode =
    normalizeString(request.configuration.permissionMode)
    ?? normalizeString(settings.selection.permissionMode)
    ?? 'auto-review';
  const safeMode = settings.codex.safeMode;
  const sandboxConfig = resolveCodexSandboxConfig(permissionMode, safeMode);
  return sandboxConfig.sandbox === 'danger-full-access'
    ? { ...sandboxConfig, sandboxPolicy: { type: 'dangerFullAccess' } }
    : sandboxConfig;
}

/**
 * The sandbox policy a turn must override, given the mode already in effect on the loaded
 * thread. turn/start cannot select a mode, and resuming a loaded thread ignores one, so a
 * mode switch must restore the policy Codex derives from the user's config for that mode.
 */
export async function resolveCodexTurnSandboxPolicy(
  policy: CodexPolicy,
  loadedThreadSandbox: string | null,
  readConfig: () => Promise<ConfigReadResult>,
): Promise<SandboxPolicy | undefined> {
  if (policy.sandboxPolicy) return policy.sandboxPolicy;
  if (loadedThreadSandbox === policy.sandbox) return undefined;
  if (policy.sandbox !== 'workspace-write') return strictReadOnlySandbox();
  const { config } = await readConfig();
  const configured = config.sandbox_workspace_write;
  return {
    type: 'workspaceWrite',
    writableRoots: configured?.writable_roots ?? [],
    networkAccess: configured?.network_access ?? false,
    excludeTmpdirEnvVar: configured?.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: configured?.exclude_slash_tmp ?? false,
  };
}

export function sandboxModeOf(policy: SandboxPolicy | undefined): string | null {
  switch (policy?.type) {
    case 'dangerFullAccess': return 'danger-full-access';
    case 'workspaceWrite': return 'workspace-write';
    case 'readOnly': return 'read-only';
    default: return null;
  }
}

/**
 * The turn's text prompt with its context. A fork replays history after its checkpoint;
 * a thread without native context replays the whole conversation.
 */
export function buildCodexTurnPrompt(
  request: ProviderExecutionRequest,
  forkCheckpoint?: string,
  replayConversationHistory = false,
): string {
  const prompt = appendExecutionContext(request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n'), request.context);

  const history = request.conversationHistory;
  if (!history?.length) return prompt;
  if (forkCheckpoint) {
    const checkpointIndex = history.findIndex(
      message => message.assistantMessageId === forkCheckpoint,
    );
    if (checkpointIndex >= 0 && checkpointIndex < history.length - 1) {
      const suffix = buildContextFromHistory(
        history.slice(checkpointIndex + 1),
      );
      if (suffix.trim()) return `${suffix}\n\nUser: ${prompt}`;
    }
    return prompt;
  }
  if (replayConversationHistory) {
    const historyContext = buildContextFromHistory(history as ChatMessage[]);
    // The envelope lets history parsing show only the visible input of the replayed turn.
    return historyContext ? buildRecoveryPrompt(historyContext, prompt, history as ChatMessage[]) : prompt;
  }
  return prompt;
}

function resolveCodexSandboxConfig(
  permissionMode: string,
  safeMode: CodexSafeMode,
): Pick<CodexPolicy, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'> {
  if (permissionMode === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: permissionMode === 'auto-review' ? 'auto_review' : 'user',
    sandbox: safeMode,
  };
}

function strictReadOnlySandbox(): SandboxPolicy {
  return {
    type: 'readOnly',
    access: { type: 'fullAccess' },
    networkAccess: false,
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
