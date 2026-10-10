import type { ProviderExecutionRequest } from '@/core/execution';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '@/core/prompt/historyContext';
import { buildSystemPrompt, type SystemPromptSettings } from '@/core/prompt/mainAgent';
import {
  appendLinkedContent,
  appendLinkedContentBody,
  appendSelectionContexts,
  appendSessionReferences,
} from '@/core/prompt/promptContext';
import type { ChatMessage } from '@/core/types';
import { getCodexModelOptions } from '@/providers/codex/modelOptions';
import {
  findCodexModel,
  getCodexReasoningEffortOptions,
  resolveCodexModelServiceTier,
  resolveCodexReasoningEffort,
} from '@/providers/codex/models';
import { toCodexRuntimeModelId } from '@/providers/codex/modelSelection';
import type { ConfigReadResult, SandboxPolicy } from '@/providers/codex/runtime/codexAppServerTypes';
import { type CodexSafeMode, getCodexProviderSettings } from '@/providers/codex/settings';

/** Resolves a turn's native configuration: model, effort, approval and sandbox policy, and prompt. */

const PASSIVE_INSTRUCTIONS =
  'Do not invoke tools. Complete the request only from the supplied input and context.';

export interface CodexPolicy {
  readonly approvalPolicy: string;
  readonly approvalsReviewer: string;
  readonly sandbox: string;
  /** Config-independent policy; config-derived modes leave the policy to Codex. */
  readonly sandboxPolicy?: SandboxPolicy;
}

/** Plugin settings with the Codex provider's saved projections applied. */
export function resolveCodexTurnSettings(pluginSettings: unknown): Record<string, unknown> {
  const settings = pluginSettings as Record<string, unknown>;
  return {
    ...settings,
    model: readProviderProjection(settings, 'savedProviderModel')
      ?? settings.model,
    effortLevel: readProviderProjection(settings, 'savedProviderEffort')
      ?? settings.effortLevel,
    serviceTier: readProviderProjection(settings, 'savedProviderServiceTier')
      ?? settings.serviceTier,
    permissionMode: readProviderProjection(
      settings,
      'savedProviderPermissionMode',
    ) ?? settings.permissionMode,
  };
}

/** The runtime model ID of an enabled selection, or null when none is usable. */
export function resolveCodexTurnModel(
  request: ProviderExecutionRequest,
  settings: Record<string, unknown>,
): string | null {
  const selected = normalizeString(request.configuration.model)
    ?? normalizeString(settings.model);
  if (!selected) return null;
  const runtimeModel = toCodexRuntimeModelId(selected);
  const enabled = getCodexModelOptions(settings).some(
    option => toCodexRuntimeModelId(option.value) === runtimeModel,
  );
  return enabled ? runtimeModel : null;
}

export function resolveCodexTurnReasoningEffort(
  request: ProviderExecutionRequest,
  settings: Record<string, unknown>,
  model: string,
): string | null {
  if (request.configuration.reasoning === null) return null;
  const codexSettings = getCodexProviderSettings(settings);
  const modelMetadata = findCodexModel(codexSettings.discoveredModels, model);
  const effort = resolveCodexReasoningEffort(
    modelMetadata,
    codexSettings.enableUltraEffort,
    normalizeString(request.configuration.reasoning)
      ?? normalizeString(settings.effortLevel),
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
  settings: Record<string, unknown>,
): string | null {
  const model = findCodexModel(
    getCodexProviderSettings(settings).discoveredModels,
    modelId,
  );
  return resolveCodexModelServiceTier(model, request.configuration.serviceTier ?? settings.serviceTier);
}

export function resolveCodexBaseInstructions(
  request: ProviderExecutionRequest,
  promptSettings: SystemPromptSettings,
): string {
  const base = request.configuration.systemInstructions.kind === 'explicit'
    ? request.configuration.systemInstructions.instructions
    : buildSystemPrompt(promptSettings);
  return request.toolPolicy.kind === 'passive'
    ? `${base}\n\n${PASSIVE_INSTRUCTIONS}`
    : base;
}

export function resolveCodexTurnPolicy(
  request: ProviderExecutionRequest,
  settings: Record<string, unknown>,
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
    ?? normalizeString(settings.permissionMode)
    ?? 'auto-review';
  const safeMode = getCodexProviderSettings(settings).safeMode;
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
  mapRequiredHostPath: (hostPath: string) => string,
  forkCheckpoint?: string,
  replayConversationHistory = false,
): string {
  let prompt = request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
  const context = request.context;
  prompt = appendSessionReferences(prompt, context?.sessionReferences, mapRequiredHostPath);
  if (context?.linkedContent) {
    prompt = context.linkedContent.content === undefined
      ? appendLinkedContent(prompt, context.linkedContent.path)
      : appendLinkedContentBody(
        prompt,
        context.linkedContent.path,
        context.linkedContent.content,
      );
  }
  prompt = appendSelectionContexts(prompt, context);

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
    return buildPromptWithHistoryContext(
      historyContext || null,
      prompt,
      prompt,
      history as ChatMessage[],
    );
  }
  return prompt;
}

function readProviderProjection(
  settings: Record<string, unknown>,
  key: string,
): unknown {
  const map = settings[key];
  return map && typeof map === 'object' && !Array.isArray(map)
    ? (map as Record<string, unknown>).codex
    : undefined;
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
