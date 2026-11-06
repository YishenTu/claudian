import * as fs from 'node:fs';
import * as path from 'node:path';

function getPathModule(value: string): typeof path.posix {
  if (
    process.platform !== 'win32'
    && path.posix.isAbsolute(value)
    && !value.startsWith('//')
  ) {
    return path.posix;
  }
  return value.startsWith('//') || value.includes('\\') || /^[A-Za-z]:/.test(value)
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

  // A missing transcript may still have an existing symlinked parent. Resolve
  // that parent before appending the missing suffix, just as for existing files.
  let current = pathModule.isAbsolute(value)
    ? value
    : `${process.cwd()}${pathModule.sep}${value}`;
  const suffix: string[] = [];
  for (;;) {
    try {
      return pathModule.join(fs.realpathSync.native(current), ...suffix.reverse());
    } catch {
      const parent = pathModule.dirname(current);
      if (parent === current) return pathModule.resolve(value);
      suffix.push(pathModule.basename(current));
      current = parent;
    }
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
