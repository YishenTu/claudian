import { isWindowsStyleCLIReference, stripSurroundingQuotes } from '@/core/process/cliPath';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';

import { getClaudeProviderSettings } from '../settings';
import { findClaudeBinaryPath } from './ClaudeBinaryLocator';

export class ClaudeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'claude',
    findBinaryPath: findClaudeBinaryPath,
    getSettingsProjection: (settings) => {
      const providerSettings = getClaudeProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'claude'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'claude',
    resolve: (context, resolveDefault) => {
      if (context.resolutionInputs?.method !== 'wsl') return resolveDefault();
      return [context.hostnamePath, context.legacyCliPath]
        .map(value => stripSurroundingQuotes(value.trim()))
        .find(value => value && !isWindowsStyleCLIReference(value)) ?? 'claude';
    },
    // A missing installation can appear before the next settings change.
    shouldCache: result => result !== null,
  });

  resolveFromSettings(settings: Record<string, unknown>, context: ProviderCLIResolutionContext = {}): string | null {
    const target = context.executionTarget ?? resolveExecutionTarget({ settings: getClaudeProviderSettings(settings) });
    return this.resolver.resolveFromSettings(settings, { ...target });
  }

  reset(): void {
    this.resolver.reset();
  }
}
