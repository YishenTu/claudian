import * as path from 'path';

export interface WslPathMapper {
  distroName: string;
  toWslPath(hostPath: string): string | null;
  toHostPath(wslPath: string): string | null;
}

function normalizeWindowsPath(value: string): string {
  let normalized = value.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\?\\UNC\\')) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice('\\\\?\\'.length);
  }
  return path.win32.normalize(normalized);
}

function normalizePosixPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function inferWslDistroFromWindowsPath(hostPath: string | null | undefined): string | undefined {
  if (!hostPath) return undefined;
  const match = hostPath.replace(/\//g, '\\').match(/^\\\\wsl\$\\([^\\]+)(?:\\|$)/i);
  return match?.[1] || undefined;
}

export function createWslPathMapper(distroName: string): WslPathMapper {
  return {
    distroName,
    toWslPath(hostPath: string): string | null {
      if (!hostPath) return null;
      const normalized = normalizeWindowsPath(hostPath);
      const uncMatch = normalized.match(/^\\\\wsl\$\\([^\\]+)(?:\\(.*))?$/i);
      if (uncMatch) {
        if (uncMatch[1].toLowerCase() !== distroName.toLowerCase()) return null;
        const tail = uncMatch[2] ? uncMatch[2].replace(/\\/g, '/') : '';
        return tail ? `/${tail}` : '/';
      }

      const driveMatch = normalized.match(/^([A-Za-z]):(?:\\(.*))?$/);
      if (!driveMatch) return null;
      const tail = (driveMatch[2] ?? '').replace(/\\/g, '/');
      return tail ? `/mnt/${driveMatch[1].toLowerCase()}/${tail}` : `/mnt/${driveMatch[1].toLowerCase()}`;
    },
    toHostPath(wslPath: string): string | null {
      if (!wslPath) return null;
      const normalized = normalizePosixPath(wslPath);
      const driveMatch = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
      if (driveMatch) {
        const tail = driveMatch[2] ? driveMatch[2].replace(/\//g, '\\') : '';
        return tail ? `${driveMatch[1].toUpperCase()}:\\${tail}` : `${driveMatch[1].toUpperCase()}:\\`;
      }

      if (!normalized.startsWith('/')) return null;
      const tail = normalized === '/' ? '' : normalized.slice(1).replace(/\//g, '\\');
      return tail
        ? `\\\\wsl$\\${distroName}\\${tail}`
        : `\\\\wsl$\\${distroName}`;
    },
  };
}
