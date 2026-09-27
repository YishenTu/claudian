import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';

import { getCodexProviderSettings } from '../settings';
import { findCodexBinaryPath, resolveCodexWSLCLIPath } from './CodexBinaryLocator';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';
import type { CodexExecutionTarget } from './codexLaunchTypes';

export class CodexCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'codex',
    findBinaryPath: findCodexBinaryPath,
    getSettingsProjection: (settings) => {
      const providerSettings = getCodexProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'codex'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'codex',
    resolve: (context, resolveDefault) => context.resolutionInputs?.method === 'wsl'
      ? resolveCodexWSLCLIPath(context.hostnamePath, context.legacyCliPath)
      : resolveDefault(),
    // Native Windows runtimes can move without a settings change; retry missing installs too.
    shouldCache: (result, context) => result !== null && context.resolutionInputs?.method !== 'native-windows',
  });

  resolveFromSettings(
    settings: Record<string, unknown>,
    context: ProviderCLIResolutionContext = {},
  ): string | null | Promise<string | null> {
    const executionTarget = getCodexExecutionTargetFromContext(context);
    if (executionTarget) {
      return this.resolver.resolveFromSettings(settings, { ...executionTarget });
    }

    return resolveCodexExecutionTargetAsync({ settings }).then((resolvedTarget) => (
      this.resolver.resolveFromSettings(settings, { ...resolvedTarget })
    ));
  }

  reset(): void {
    this.resolver.reset();
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
