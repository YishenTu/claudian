import type { PiFamilyModelContract } from '../models';

export interface PiSetModelPayload extends Record<string, unknown> {
  modelId: string;
  provider: string;
}

export function buildPiSetModelPayload(model: string, models: PiFamilyModelContract): PiSetModelPayload | null {
  const decoded = models.decodeModelId(model);
  if (!decoded) {
    return null;
  }

  return {
    modelId: decoded.modelId,
    provider: decoded.provider,
  };
}
