import type { OpencodeDiscoveredModel, OpencodeThinkingOptionsByModel } from '../models';

export function sameDiscoveredModels(
  left: OpencodeDiscoveredModel[],
  right: OpencodeDiscoveredModel[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((model, index) => (
    model.rawId === right[index]?.rawId
    && model.label === right[index]?.label
    && (model.description ?? '') === (right[index]?.description ?? '')
  ));
}

export function sameThinkingOptionsByModel(
  left: OpencodeThinkingOptionsByModel,
  right: OpencodeThinkingOptionsByModel,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }

  return leftEntries.every(([rawId, leftOptions]) => {
    const rightOptions = right[rawId] ?? [];
    if (leftOptions.length !== rightOptions.length) {
      return false;
    }

    return leftOptions.every((option, index) => (
      option.value === rightOptions[index]?.value
      && option.label === rightOptions[index]?.label
      && (option.description ?? '') === (rightOptions[index]?.description ?? '')
    ));
  });
}
