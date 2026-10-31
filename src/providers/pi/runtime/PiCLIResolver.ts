import { isWindowsStyleCLIReference, stripSurroundingQuotes } from '@/core/process/cliPath';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';

import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getPiProviderSettings } from '../settings';

export class PiCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'pi',
    getSettingsProjection: (settings) => {
      const providerSettings = getPiProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'pi'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'pi',
    resolve: (context, resolveDefault) => {
      if (context.resolutionInputs?.method !== 'wsl') return resolveDefault();
      for (const reference of [context.hostnamePath, context.legacyCliPath]) {
        const candidate = stripSurroundingQuotes(reference.trim());
        if (candidate && !isWindowsStyleCLIReference(candidate)) return candidate;
      }
      return 'pi';
    },
  });

  resolveFromSettings(settings: Record<string, unknown>, context: ProviderCLIResolutionContext = {}): string | null {
    const target = context.executionTarget ?? resolveExecutionTarget({ settings: getPiProviderSettings(settings) });
    return this.resolver.resolveFromSettings(settings, { ...target });
  }

  reset(): void {
    this.resolver.reset();
  }
}
