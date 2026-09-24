import { t } from '../../i18n/i18n';
import type {
  ProviderId,
  TitleGenerationCallback,
  TitleGenerationService,
} from '../providers/types';

interface RoutedTitleGenerationOptions {
  resolveProviderId(): ProviderId | null;
  initializeProvider(providerId: ProviderId): Promise<void>;
  createService(providerId: ProviderId): TitleGenerationService;
}

interface ActiveGeneration {
  service?: TitleGenerationService;
}

/** Owns title requests from provider preparation through result publication. */
export class RoutedTitleGenerationService implements TitleGenerationService {
  private readonly activeGenerations = new Map<string, ActiveGeneration>();

  constructor(private readonly options: RoutedTitleGenerationOptions) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const generation: ActiveGeneration = {};
    const previous = this.activeGenerations.get(conversationId);
    this.activeGenerations.set(conversationId, generation);
    previous?.service?.cancel();

    try {
      const providerId = this.options.resolveProviderId();
      if (!providerId) {
        await callback(conversationId, {
          success: false,
          error: t('chat.selectAvailableTitleModel'),
        });
        return;
      }
      await this.options.initializeProvider(providerId);
      if (this.activeGenerations.get(conversationId) !== generation) return;

      if (this.options.resolveProviderId() !== providerId) {
        await callback(conversationId, {
          success: false,
          error: 'The title model became unavailable or changed during initialization.',
        });
        return;
      }
      const service = this.options.createService(providerId);
      generation.service = service;
      await service.generateTitle(conversationId, userMessage, async (convId, result) => {
        if (this.activeGenerations.get(conversationId) !== generation) return;
        await callback(convId, result);
      });
    } finally {
      if (this.activeGenerations.get(conversationId) === generation) {
        this.activeGenerations.delete(conversationId);
      }
    }
  }

  cancel(): void {
    const active = [...this.activeGenerations.values()];
    this.activeGenerations.clear();
    for (const generation of active) generation.service?.cancel();
  }
}
