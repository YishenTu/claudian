import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCLIResolutionContext } from '../../../core/providers/types';
import { getHostnameKey } from '../../../utils/env';
import { getCodexProviderSettings } from '../settings';
import { resolveCodexCLIPath } from './CodexBinaryLocator';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';
import type { CodexExecutionTarget } from './codexLaunchTypes';

export class CodexCLIResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  private lastExecutionTargetKey = '';
  private readonly cachedHostname = getHostnameKey();

  resolveFromSettings(
    settings: Record<string, unknown>,
    context: ProviderCLIResolutionContext = {},
  ): string | null | Promise<string | null> {
    const codexSettings = getCodexProviderSettings(settings);
    const hostnamePath = (codexSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const legacyPath = codexSettings.cliPath.trim();
    const envText = getRuntimeEnvironmentText(settings, 'codex');
    const executionTarget = getCodexExecutionTargetFromContext(context);
    if (executionTarget) {
      return this.#resolveAndCache(hostnamePath, legacyPath, envText, executionTarget);
    }

    return resolveCodexExecutionTargetAsync({ settings }).then((resolvedTarget) => (
      this.#resolveAndCache(hostnamePath, legacyPath, envText, resolvedTarget)
    ));
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
    this.lastExecutionTargetKey = '';
  }

  #resolveAndCache(
    hostnamePath: string,
    legacyPath: string,
    envText: string,
    executionTarget: CodexExecutionTarget,
  ): string | null {
    const executionTargetKey = getCodexExecutionTargetCacheKey(executionTarget);

    // Native Windows desktop runtimes can change directories without a settings change.
    if (
      executionTarget.method !== 'native-windows' &&
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      legacyPath === this.lastLegacyPath &&
      envText === this.lastEnvText &&
      executionTargetKey === this.lastExecutionTargetKey
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = legacyPath;
    this.lastEnvText = envText;
    this.lastExecutionTargetKey = executionTargetKey;

    this.resolvedPath = resolveCodexCLIPath(hostnamePath, legacyPath, envText, {
      executionTarget,
    });
    return this.resolvedPath;
  }
}

function isCodexExecutionTarget(value: unknown): value is CodexExecutionTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CodexExecutionTarget>;
  return candidate.method === 'host-native'
    || candidate.method === 'native-windows'
    || candidate.method === 'wsl';
}

function getCodexExecutionTargetFromContext(
  context: ProviderCLIResolutionContext,
): CodexExecutionTarget | null {
  return isCodexExecutionTarget(context.executionTarget)
    ? context.executionTarget
    : null;
}

function getCodexExecutionTargetCacheKey(target: CodexExecutionTarget): string {
  return [
    target.method,
    target.platformFamily,
    target.platformOs,
    target.distroName ?? '',
  ].join(':');
}
