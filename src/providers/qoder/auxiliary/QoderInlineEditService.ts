import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  InlineEditRequest,
  InlineEditResult,
} from '../../../core/providers/types';
import { QoderCliResolver } from '../runtime/QoderCliResolver';
import { QoderAuxQueryRunner } from './QoderAuxQueryRunner';

export class QoderInlineEditService {
  private readonly delegate: QueryBackedInlineEditService;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly cliResolver = new QoderCliResolver(),
  ) {
    this.delegate = new QueryBackedInlineEditService(
      new QoderAuxQueryRunner(this.plugin, this.cliResolver),
    );
  }

  setModelOverride(model?: string): void {
    this.delegate.setModelOverride(model);
  }

  resetConversation(): void {
    this.delegate.resetConversation();
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    return this.delegate.editText(request);
  }

  async continueConversation(
    message: string,
    contextFiles?: string[],
  ): Promise<InlineEditResult> {
    return this.delegate.continueConversation(message, contextFiles);
  }

  cancel(): void {
    this.delegate.cancel();
  }
}
