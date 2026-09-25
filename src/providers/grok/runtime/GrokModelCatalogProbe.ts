import { ACPJSONRPCTransport, ACPSubprocess } from '../../acp';
import {
  type NormalizedGrokSessionModels,
  normalizeGrokSessionModelMetadata,
  parseGrokModelUpdateState,
} from '../execution/GrokSessionModelMetadata';

export interface GrokModelCatalogProbeRequest {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  version: string;
}

export interface GrokModelCatalogProbeLike {
  discover(request: GrokModelCatalogProbeRequest): Promise<NormalizedGrokSessionModels>;
}

/** Owns a short-lived ACP process; model discovery never creates a chat session. */
export class GrokModelCatalogProbe implements GrokModelCatalogProbeLike {
  async discover(request: GrokModelCatalogProbeRequest): Promise<NormalizedGrokSessionModels> {
    request.signal?.throwIfAborted();
    const process = new ACPSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command: request.command,
      cwd: request.cwd,
      env: request.env,
    });
    let transport: ACPJSONRPCTransport | undefined;
    try {
      process.start();
      transport = new ACPJSONRPCTransport({
        input: process.stdout,
        onClose: listener => process.onClose(listener),
        output: process.stdin,
      });
      const options = { signal: request.signal, timeoutMs: request.timeoutMs };
      await transport.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'claudian', version: request.version },
      }, options);
      const response = await transport.request<{ error?: unknown; result?: unknown } | null>(
        '_x.ai/models/list', {}, options,
      );
      // xAI wraps the model state inside an extension result within the JSON-RPC result.
      const models = response?.error == null ? parseGrokModelUpdateState(response?.result) : null;
      if (!models) throw new Error('Grok returned malformed model metadata.');
      const catalog = normalizeGrokSessionModelMetadata({ models });
      // The catalog is a complete capability snapshot; session updates may be partial.
      return {
        ...catalog,
        models: catalog.models.map(model => ({ ...model, reasoningMetadataResolved: true })),
      };
    } finally {
      transport?.dispose();
      await process.shutdown();
    }
  }
}
