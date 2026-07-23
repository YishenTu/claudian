import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { RefineProgressCallback } from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import { QoderCliResolver } from '../runtime/QoderCliResolver';
import { QoderAuxQueryRunner } from './QoderAuxQueryRunner';

export class QoderInstructionRefineService {
  private readonly delegate: QueryBackedInstructionRefineService;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly cliResolver = new QoderCliResolver(),
  ) {
    this.delegate = new QueryBackedInstructionRefineService(
      new QoderAuxQueryRunner(this.plugin, this.cliResolver),
    );
  }

  setModelOverride(model?: string): void {
    this.delegate.setModelOverride(model);
  }

  resetConversation(): void {
    this.delegate.resetConversation();
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return this.delegate.refineInstruction(rawInstruction, existingInstructions, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return this.delegate.continueConversation(message, onProgress);
  }

  cancel(): void {
    this.delegate.cancel();
  }
}
