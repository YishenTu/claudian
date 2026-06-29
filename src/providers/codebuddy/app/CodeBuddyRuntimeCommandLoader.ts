import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import { getCodeBuddyProviderSettings } from '../settings';

export class CodeBuddyRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean {
    return getCodeBuddyProviderSettings(settings).enabled;
  }

  async loadCommands(context: ProviderRuntimeCommandLoaderContext) {
    if (!context.runtime || context.runtime.providerId !== 'codebuddy') {
      return [];
    }
    if (!(await context.runtime.ensureReady({ allowSessionCreation: context.allowSessionCreation }))) {
      return [];
    }
    return context.runtime.getSupportedCommands();
  }
}
