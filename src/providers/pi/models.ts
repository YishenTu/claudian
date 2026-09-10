import {
  clampPiThinkingLevel,
  type DecodedPiModelId,
  definePiFamilyModels,
  findPiModel,
  getPiSupportedThinkingLevels,
  normalizePiThinkingLevel,
  PI_DEFAULT_THINKING_LEVEL,
  type PiDiscoveredModel,
  type PiThinkingLevel,
} from '../pi-rpc/models';

export type { DecodedPiModelId, PiDiscoveredModel, PiThinkingLevel };
export {
  clampPiThinkingLevel,
  findPiModel,
  getPiSupportedThinkingLevels,
  normalizePiThinkingLevel,
  PI_DEFAULT_THINKING_LEVEL,
};

export const piFamilyModels = definePiFamilyModels('pi:');

export const encodePiModelId = piFamilyModels.encodeModelId;
export const decodePiModelId = piFamilyModels.decodeModelId;
export const isPiModelSelectionId = piFamilyModels.isModelSelectionId;
export const normalizePiDiscoveredModels = piFamilyModels.normalizeDiscoveredModels;
