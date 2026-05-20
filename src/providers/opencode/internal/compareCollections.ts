import type { OpencodeDiscoveredModel, OpencodeThinkingOptionsByModel } from '../models';
import type { OpencodeMode } from '../modes';

export function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}

export function sameStringMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key] === value);
}

export function sameModes(left: OpencodeMode[], right: OpencodeMode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((mode, index) => (
    mode.id === right[index]?.id
    && mode.name === right[index]?.name
    && (mode.description ?? '') === (right[index]?.description ?? '')
  ));
}

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
