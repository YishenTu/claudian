import type { PiDiscoveredModel } from '../models';

export function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function sameDiscoveredModels(
  left: PiDiscoveredModel[],
  right: PiDiscoveredModel[],
): boolean {
  return left.length === right.length
    && left.every((model, index) => {
      const candidate = right[index];
      return model.api === candidate?.api
        && model.contextWindow === candidate?.contextWindow
        && model.encodedId === candidate?.encodedId
        && model.id === candidate?.id
        && sameStringList(model.input, candidate?.input ?? [])
        && model.label === candidate?.label
        && model.maxTokens === candidate?.maxTokens
        && model.provider === candidate?.provider
        && model.reasoning === candidate?.reasoning
        && sameStringList(model.thinkingLevels, candidate?.thinkingLevels ?? []);
    });
}
