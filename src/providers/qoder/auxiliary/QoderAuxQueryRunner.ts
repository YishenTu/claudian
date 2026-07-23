import type { Query } from '@qoder-ai/qoder-agent-sdk';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import { loadQoderQuery } from '../runtime/loadQoderSdk';
import type { QoderCliResolver } from '../runtime/QoderCliResolver';
import { buildQoderBaseOptions, closeQoderQuery } from '../runtime/QoderSdkBridge';

export class QoderAuxQueryRunner implements AuxQueryRunner {
  private activeQuery: Query | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly cliResolver: QoderCliResolver,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    this.reset();
    const queryFactory = await loadQoderQuery();
    const q = queryFactory({
      prompt,
      options: {
        ...buildQoderBaseOptions({
          cliResolver: this.cliResolver,
          model: config.model,
          plugin: this.plugin,
        }),
        abortController: config.abortController,
        cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
        systemPrompt: config.systemPrompt,
      },
    });
    this.activeQuery = q;

    let text = '';
    try {
      for await (const message of q) {
        if (message.type === 'assistant') {
          text = extractAssistantText(message.message.content) || text;
          config.onTextChunk?.(text);
        } else if (message.type === 'stream_event') {
          const deltaText = extractStreamDeltaText(message.event);
          if (deltaText) {
            text += deltaText;
            config.onTextChunk?.(text);
          }
        }
      }
      return text;
    } finally {
      await closeQoderQuery(q);
      if (this.activeQuery === q) {
        this.activeQuery = null;
      }
    }
  }

  reset(): void {
    const q = this.activeQuery;
    this.activeQuery = null;
    void closeQoderQuery(q);
  }
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: string; text?: string } => (
      !!block && typeof block === 'object' && !Array.isArray(block)
    ))
    .map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join('');
}

function extractStreamDeltaText(event: unknown): string {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return '';
  }

  const record = event as Record<string, unknown>;
  const delta = record.delta;
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    return '';
  }

  const deltaRecord = delta as Record<string, unknown>;
  if (typeof deltaRecord.text === 'string') {
    return deltaRecord.text;
  }
  if (typeof deltaRecord.partial_json === 'string') {
    return deltaRecord.partial_json;
  }
  if (typeof deltaRecord.thinking === 'string') {
    return deltaRecord.thinking;
  }
  return '';
}
