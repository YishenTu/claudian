import type { KimiDiscoveredModel, KimiThinkingOptionsByModel } from '../models';
import type { KimiMode } from '../modes';

export function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function sameStringMap(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function sameDiscoveredModels(
  a: KimiDiscoveredModel[],
  b: KimiDiscoveredModel[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].rawId !== b[i].rawId
      || a[i].label !== b[i].label
      || (a[i].description ?? '') !== (b[i].description ?? '')
    ) {
      return false;
    }
  }
  return true;
}

export function sameModes(a: KimiMode[], b: KimiMode[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id
      || a[i].name !== b[i].name
      || (a[i].description ?? '') !== (b[i].description ?? '')
    ) {
      return false;
    }
  }
  return true;
}

export function sameThinkingOptionsByModel(
  a: KimiThinkingOptionsByModel,
  b: KimiThinkingOptionsByModel,
): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (!sameStringList(aKeys, bKeys)) {
    return false;
  }
  for (const key of aKeys) {
    const aOptions = a[key] ?? [];
    const bOptions = b[key] ?? [];
    if (aOptions.length !== bOptions.length) {
      return false;
    }
    for (let i = 0; i < aOptions.length; i++) {
      if (
        aOptions[i].value !== bOptions[i].value
        || aOptions[i].label !== bOptions[i].label
        || (aOptions[i].description ?? '') !== (bOptions[i].description ?? '')
      ) {
        return false;
      }
    }
  }
  return true;
}
