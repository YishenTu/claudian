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
export {
  clampPiThinkingLevel,
  findPiModel,
  getPiSupportedThinkingLevels,
  normalizePiThinkingLevel,
  PI_DEFAULT_THINKING_LEVEL,
};

export type { DecodedPiModelId, PiDiscoveredModel, PiThinkingLevel };

export const ompFamilyModels = definePiFamilyModels('omp:');

export const encodeOmpModelId = ompFamilyModels.encodeModelId;
export const decodeOmpModelId = ompFamilyModels.decodeModelId;
export const isOmpModelSelectionId = ompFamilyModels.isModelSelectionId;
export const normalizeOmpDiscoveredModels = ompFamilyModels.normalizeDiscoveredModels;
