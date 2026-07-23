import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { TitleGenerationCallback } from '../../../core/providers/types';
import { QoderCliResolver } from '../runtime/QoderCliResolver';
import { QoderAuxQueryRunner } from './QoderAuxQueryRunner';

export class QoderTitleGenerationService {
  private readonly delegate: QueryBackedTitleGenerationService;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly cliResolver = new QoderCliResolver(),
  ) {
    this.delegate = new QueryBackedTitleGenerationService({
      createRunner: () => new QoderAuxQueryRunner(this.plugin, this.cliResolver),
    });
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    await this.delegate.generateTitle(conversationId, userMessage, callback);
  }

  cancel(): void {
    this.delegate.cancel();
  }
}
