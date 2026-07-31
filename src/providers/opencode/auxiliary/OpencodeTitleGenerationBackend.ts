import { AuxQueryTitleGenerationBackend } from '../../../core/auxiliary/AuxQueryTitleGenerationBackend';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { decodeOpencodeModelId } from '../models';
import { OpencodeAuxQueryRunner } from '../runtime/OpencodeAuxQueryRunner';
import { opencodeChatUIConfig } from '../ui/OpencodeChatUIConfig';

export class OpencodeTitleGenerationBackend extends AuxQueryTitleGenerationBackend {
  constructor(plugin: ProviderHost) {
    super(
      new OpencodeAuxQueryRunner(plugin, {
        agentProfile: 'passive',
        artifactPurpose: 'title-gen',
      }),
      () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        if (!opencodeChatUIConfig.ownsModel(titleModel, settings)) {
          return undefined;
        }

        return decodeOpencodeModelId(titleModel) ?? undefined;
      },
    );
  }
}
