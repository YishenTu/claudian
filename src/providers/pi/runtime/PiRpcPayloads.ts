import { decodePiModelId } from '../models';

export interface PiSetModelPayload extends Record<string, unknown> {
  modelId: string;
  provider: string;
}

export function buildPiSetModelPayload(model: string): PiSetModelPayload | null {
  const decoded = decodePiModelId(model);
  if (!decoded) {
    return null;
  }

  return {
    modelId: decoded.modelId,
    provider: decoded.provider,
  };
}
