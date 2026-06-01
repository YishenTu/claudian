import { decodePiModelId, normalizePiThinkingLevel } from '../models';
import type { PiProviderSettings } from '../settings';
import type { PiProviderState } from '../types';

export interface BuildPiLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envText?: string;
  model?: string | null;
  noSession?: boolean;
  noTools?: boolean;
  providerState?: PiProviderState | null;
  settings: PiProviderSettings;
  systemPrompt?: string;
  thinkingLevel?: string | null;
}

export interface PiLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launchKey: string;
}

const READONLY_TOOLS = 'read,grep,find,ls';

export function buildPiLaunchSpec(params: BuildPiLaunchSpecParams): PiLaunchSpec {
  const args = ['--mode', 'rpc'];
  const systemPrompt = params.systemPrompt?.trim();
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  if (params.noSession) {
    args.push('--no-session');
  } else if (params.providerState?.sessionFile || params.providerState?.sessionId) {
    args.push('--session', params.providerState.sessionFile ?? params.providerState.sessionId!);
  }

  if (params.noTools) {
    args.push('--no-tools');
  } else if (params.settings.toolMode === 'readonly') {
    args.push('--tools', READONLY_TOOLS);
  }

  const decodedModel = typeof params.model === 'string' ? decodePiModelId(params.model) : null;
  if (decodedModel) {
    args.push('--provider', decodedModel.provider, '--model', decodedModel.modelId);
  }

  const thinkingLevel = normalizePiThinkingLevel(params.thinkingLevel);
  if (thinkingLevel && thinkingLevel !== 'off') {
    args.push('--thinking', thinkingLevel);
  }

  return {
    args,
    command: params.command,
    cwd: params.cwd,
    env: params.env ?? process.env,
    launchKey: JSON.stringify({
      args,
      command: params.command,
      cwd: params.cwd,
      envText: params.envText ?? params.settings.environmentVariables,
    }),
  };
}
