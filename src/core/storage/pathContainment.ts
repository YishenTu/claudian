import * as fs from 'node:fs';
import * as path from 'node:path';

function getPathModule(value: string): typeof path.posix {
  return value.includes('\\') || /^[A-Za-z]:/.test(value)
    ? path.win32
    : path.posix;
}

function isHostPath(pathModule: typeof path.posix): boolean {
  return process.platform === 'win32'
    ? pathModule === path.win32
    : pathModule === path.posix;
}

function resolveExistingPath(value: string, pathModule: typeof path.posix): string {
  if (!isHostPath(pathModule)) {
    return pathModule.resolve(value);
  }

  try {
    return fs.realpathSync.native(value);
  } catch {
    return pathModule.resolve(value);
  }
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  if (!candidate.trim() || !root.trim()) {
    return false;
  }

  const pathModule = getPathModule(root);
  if (getPathModule(candidate) !== pathModule) {
    return false;
  }

  const normalizedRoot = resolveExistingPath(root, pathModule);
  const normalizedCandidate = resolveExistingPath(candidate, pathModule);
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);

  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(relative)
  );
}

export function isSamePath(left: string, right: string): boolean {
  return isPathWithinRoot(left, right) && isPathWithinRoot(right, left);
}
