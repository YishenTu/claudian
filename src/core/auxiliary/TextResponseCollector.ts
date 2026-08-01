import type {
  ProviderExecutionErrorCategory,
  ProviderExecutionRun,
} from '../execution';

export class AuxiliaryExecutionError extends Error {
  constructor(
    message: string,
    readonly category: ProviderExecutionErrorCategory,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'AuxiliaryExecutionError';
  }
}

export class TextResponseCollector {
  async collect(
    run: ProviderExecutionRun,
    onProgress?: (accumulatedText: string) => void,
  ): Promise<string> {
    let text = '';
    let completed = false;
    for await (const event of run.events) {
      if (event.type === 'text_delta') {
        text += event.text;
        onProgress?.(text);
        continue;
      }
      if (event.type === 'turn_completed') {
        completed = true;
        continue;
      }
      if (event.type === 'cancelled') {
        throw new AuxiliaryExecutionError(
          event.reason ?? 'Cancelled',
          'provider',
          true,
        );
      }
      if (event.type === 'execution_error') {
        throw new AuxiliaryExecutionError(
          event.message,
          event.category,
          event.recoverable,
        );
      }
    }
    if (!completed) {
      throw new AuxiliaryExecutionError(
        'Provider execution ended without a terminal event.',
        'transport',
        true,
      );
    }
    return text;
  }
}
