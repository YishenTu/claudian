import { AuxQueryTitleGenerationBackend } from '../../../core/auxiliary/AuxQueryTitleGenerationBackend';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { PiAuxQueryRunner } from '../runtime/PiAuxQueryRunner';
import { piChatUIConfig } from '../ui/PiChatUIConfig';

export class PiTitleGenerationBackend extends AuxQueryTitleGenerationBackend {
  constructor(plugin: ProviderHost) {
    super(
      new PiAuxQueryRunner(plugin, { profile: 'passive' }),
      () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return piChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
      },
    );
  }
}
