export type VaultFileTreeEntry = {
  kind: 'file' | 'folder';
  path: string;
};

export function isVisibleVaultPath(path: string): boolean {
  if (path.length === 0 || /^\/+$/u.test(path)) return false;
  return !path.split('/').some(segment => segment.startsWith('.'));
}

export function collectVaultFileTreePaths(
  entries: readonly VaultFileTreeEntry[],
): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const treePath = toVaultFileTreePath(entry);
    if (treePath !== null) paths.push(treePath);
  }
  return paths;
}

export function toVaultFileTreePath({ kind, path }: VaultFileTreeEntry): string | null {
  if (!isVisibleVaultPath(path)) return null;
  return kind === 'folder' && !path.endsWith('/') ? `${path}/` : path;
}

export function toVaultPath(treePath: string): string {
  return treePath.endsWith('/') ? treePath.slice(0, -1) : treePath;
}
