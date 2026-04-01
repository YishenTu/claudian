import type { SDKNativeMessage } from './sdkHistoryTypes';

export function filterActiveBranch(
  entries: SDKNativeMessage[],
  resumeAtMessageId?: string,
): SDKNativeMessage[] {
  if (entries.length === 0) {
    return [];
  }

  function isRealUserBranchChild(entry: SDKNativeMessage | undefined): boolean {
    return !!entry
      && entry.type === 'user'
      && !('toolUseResult' in entry)
      && !entry.isMeta
      && !('sourceToolUseID' in entry);
  }

  function isDirectRealUserBranchChild(parentUuid: string, entry: SDKNativeMessage | undefined): boolean {
    return !!entry && entry.parentUuid === parentUuid && isRealUserBranchChild(entry);
  }

  const seen = new Set<string>();
  const deduped: SDKNativeMessage[] = [];
  for (const entry of entries) {
    if (entry.uuid) {
      if (seen.has(entry.uuid)) {
        continue;
      }
      seen.add(entry.uuid);
    }
    deduped.push(entry);
  }

  const progressUuids = new Set<string>();
  const progressParentOf = new Map<string, string | null>();
  for (const entry of deduped) {
    if ((entry.type as string) === 'progress' && entry.uuid) {
      progressUuids.add(entry.uuid);
      progressParentOf.set(entry.uuid, entry.parentUuid ?? null);
    }
  }

  function resolveParent(parentUuid: string | null | undefined): string | null | undefined {
    if (!parentUuid) {
      return parentUuid;
    }

    let current: string | null = parentUuid;
    let guard = progressUuids.size + 1;
    while (current && progressUuids.has(current)) {
      if (--guard < 0) {
        break;
      }
      current = progressParentOf.get(current) ?? null;
    }

    return current;
  }

  const conversationEntries = deduped.filter(entry => (entry.type as string) !== 'progress');
  const byUuid = new Map<string, SDKNativeMessage>();
  const childrenOf = new Map<string, Set<string>>();

  for (const entry of conversationEntries) {
    if (entry.uuid) {
      byUuid.set(entry.uuid, entry);
    }

    const effectiveParent = resolveParent(entry.parentUuid) ?? null;
    if (effectiveParent && entry.uuid) {
      let children = childrenOf.get(effectiveParent);
      if (!children) {
        children = new Set();
        childrenOf.set(effectiveParent, children);
      }
      children.add(entry.uuid);
    }
  }

  function findLatestLeaf(): SDKNativeMessage | undefined {
    for (let i = conversationEntries.length - 1; i >= 0; i--) {
      const uuid = conversationEntries[i].uuid;
      if (uuid && !childrenOf.has(uuid)) {
        return conversationEntries[i];
      }
    }
    return undefined;
  }

  const latestLeaf = findLatestLeaf();
  const latestBranchUuids = new Set<string>();
  const activeChildOf = new Map<string, string>();

  let latestCurrent = latestLeaf;
  while (latestCurrent?.uuid) {
    latestBranchUuids.add(latestCurrent.uuid);
    const parent = resolveParent(latestCurrent.parentUuid);
    if (parent) {
      activeChildOf.set(parent, latestCurrent.uuid);
    }
    latestCurrent = parent ? byUuid.get(parent) : undefined;
  }

  const conversationContentCache = new Map<string, boolean>();
  function hasConversationContent(uuid: string): boolean {
    const cached = conversationContentCache.get(uuid);
    if (cached !== undefined) {
      return cached;
    }

    const entry = byUuid.get(uuid);
    let result = false;
    if (entry?.type === 'assistant') {
      result = true;
    } else if (entry?.type === 'user' && !entry.isMeta && !('sourceToolUseID' in entry)) {
      result = true;
    } else {
      const children = childrenOf.get(uuid);
      if (children) {
        for (const childUuid of children) {
          if (hasConversationContent(childUuid)) {
            result = true;
            break;
          }
        }
      }
    }

    conversationContentCache.set(uuid, result);
    return result;
  }

  const hasBranching = [...latestBranchUuids].some(uuid => {
    const children = childrenOf.get(uuid);
    if (!children || children.size <= 1) {
      return false;
    }

    const activeChildUuid = activeChildOf.get(uuid);
    let sawRealUserChild = false;
    let sawAlternateConversationChild = false;

    for (const childUuid of children) {
      const child = byUuid.get(childUuid);
      if (isDirectRealUserBranchChild(uuid, child)) {
        sawRealUserChild = true;
      }
      if (childUuid !== activeChildUuid && hasConversationContent(childUuid)) {
        sawAlternateConversationChild = true;
      }
      if (sawRealUserChild && sawAlternateConversationChild) {
        return true;
      }
    }

    return false;
  });

  let leaf: SDKNativeMessage | undefined;
  if (hasBranching) {
    leaf = latestLeaf;
    if (resumeAtMessageId && leaf?.uuid && byUuid.has(resumeAtMessageId)) {
      let current: SDKNativeMessage | undefined = leaf;
      while (current?.uuid) {
        if (current.uuid === resumeAtMessageId) {
          leaf = current;
          break;
        }
        const parent = resolveParent(current.parentUuid);
        current = parent ? byUuid.get(parent) : undefined;
      }
    }
  } else if (resumeAtMessageId) {
    leaf = byUuid.get(resumeAtMessageId);
  } else {
    return conversationEntries;
  }

  if (!leaf?.uuid) {
    return conversationEntries;
  }

  const activeUuids = new Set<string>();
  let current: SDKNativeMessage | undefined = leaf;
  while (current?.uuid) {
    activeUuids.add(current.uuid);
    const parent = resolveParent(current.parentUuid);
    current = parent ? byUuid.get(parent) : undefined;
  }

  if (hasBranching) {
    const ancestorUuids = [...activeUuids];
    const pending: string[] = [];

    for (const uuid of ancestorUuids) {
      const children = childrenOf.get(uuid);
      if (!children || children.size <= 1) {
        continue;
      }

      const activeChildUuid = activeChildOf.get(uuid);
      if (activeChildUuid && isDirectRealUserBranchChild(uuid, byUuid.get(activeChildUuid))) {
        continue;
      }

      for (const childUuid of children) {
        if (activeUuids.has(childUuid)) {
          continue;
        }

        const child = byUuid.get(childUuid);
        if (!child || isRealUserBranchChild(child)) {
          continue;
        }

        activeUuids.add(childUuid);
        pending.push(childUuid);
      }
    }

    while (pending.length > 0) {
      const parentUuid = pending.pop()!;
      const children = childrenOf.get(parentUuid);
      if (!children) {
        continue;
      }

      for (const childUuid of children) {
        if (activeUuids.has(childUuid)) {
          continue;
        }

        const child = byUuid.get(childUuid);
        if (!child || isRealUserBranchChild(child)) {
          continue;
        }

        activeUuids.add(childUuid);
        pending.push(childUuid);
      }
    }
  }

  const entryCount = conversationEntries.length;
  const prevIsActive = new Array<boolean>(entryCount);
  const nextIsActive = new Array<boolean>(entryCount);

  let lastPrevActive = false;
  for (let i = 0; i < entryCount; i++) {
    if (conversationEntries[i].uuid) {
      lastPrevActive = activeUuids.has(conversationEntries[i].uuid!);
    }
    prevIsActive[i] = lastPrevActive;
  }

  let lastNextActive = false;
  for (let i = entryCount - 1; i >= 0; i--) {
    if (conversationEntries[i].uuid) {
      lastNextActive = activeUuids.has(conversationEntries[i].uuid!);
    }
    nextIsActive[i] = lastNextActive;
  }

  return conversationEntries.filter((entry, idx) => {
    if (entry.uuid) {
      return activeUuids.has(entry.uuid);
    }
    return prevIsActive[idx] && nextIsActive[idx];
  });
}
