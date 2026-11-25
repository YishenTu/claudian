import { decodePiModelId, type PiDiscoveredModel } from '../models';

export interface PiSetModelPayload extends Record<string, unknown> {
  modelId: string;
  provider: string;
}

/** A discovered model keeps Pi's own provider and id; provider ids may contain `/` (Pi 1.5+). */
export function buildPiSetModelPayload(
  model: string,
  discovered?: Pick<PiDiscoveredModel, 'id' | 'provider'> | null,
): PiSetModelPayload | null {
  if (discovered) {
    return { modelId: discovered.id, provider: discovered.provider };
  }
  const decoded = decodePiModelId(model);
  if (!decoded) {
    return null;
  }

  return {
    modelId: decoded.modelId,
    provider: decoded.provider,
  };
}
