import type * as NodeFS from 'node:fs';
import * as fs from 'node:fs';
import type * as NodeFSPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const UNC_PATH = /^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/iu;
const DRIVE_PATH = /^([a-z]):(\/.*)?$/iu;
const MOUNTED_DRIVE = /^\/mnt\/([a-z])(\/.*)?$/u;
// Captured at import, before tests stub `process.platform`: the module path flavor is the real host's.
const HOST_IS_WINDOWS = path.sep === '\\';

/** Path-taking functions production reads, writes and resolves through. */
const FS_FUNCTIONS = new Set<string>([
  'createReadStream', 'existsSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'statSync',
  'unwatchFile', 'watchFile',
] satisfies (keyof typeof NodeFS)[]);
const FS_PROMISES_FUNCTIONS = new Set<string>([
  'access', 'copyFile', 'lstat', 'mkdir', 'mkdtemp', 'open', 'readFile', 'readdir', 'realpath', 'rename', 'rm', 'stat', 'writeFile',
] satisfies (keyof typeof NodeFSPromises)[]);
/** Functions that return a path, which maps back to the Windows host path. */
const RETURNS_PATH = new Set(['mkdtemp', 'realpath', 'realpathSync']);
/** Leading path arguments; the rest (such as file contents) pass through unchanged. */
const PATH_ARGUMENT_COUNT: Readonly<Record<string, number>> = { copyFile: 2, rename: 2 };

export interface WindowsHostFSOptions {
  /** The real host's platform; a Windows host has the real paths, so its suites skip instead. */
  hostPlatform?: 'win32' | 'posix';
  /** Native temp directory, never redirected even when it is Windows-shaped. */
  hostTmpDir?: string;
}

/**
 * Real files behind Windows host paths on a POSIX test host: drive paths (`C:\…`) and each distro's
 * `\\wsl$` / `\\wsl.localhost` share. As on Windows, share, distro and drive paths match case-insensitively
 * and keep the casing of the existing entry; Linux paths inside a distro are case-sensitive, so a
 * case-only variant of an existing distro entry throws instead of depending on the host filesystem.
 * realpath and mkdtemp results map back to `\\wsl$\<Distro>\…` and `<DRIVE>:\…`. A distro's `/mnt/<drive>` is the
 * Windows drive: `fromLinux('/mnt/c/…')` is `C:\…`; the share route to `/mnt` is not aliased, so a reader
 * that maps drive files through the distro share is detected. Listed fs functions are redirected;
 * any other fs function given a Windows-shaped path throws, so a missed redirect is visible.
 * The calling test forwards `fs` and `fs/promises` through `vi.mock` so the namespaces are writable.
 */
export function createWindowsHostFS(
  modules: { fs: typeof NodeFS; fsPromises: typeof NodeFSPromises },
  options: WindowsHostFSOptions = {},
) {
  if ((options.hostPlatform ?? (HOST_IS_WINDOWS ? 'win32' : 'posix')) === 'win32') {
    throw new Error('WindowsHostFS models Windows paths on POSIX hosts; skip this suite on Windows, where they are real');
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'claudian-windows-host-')));
  const native = [root, options.hostTmpDir ?? tmpdir()].map(normalizeSeparators).map(value => value.toLowerCase());
  const isNative = (value: string) => {
    const lower = normalizeSeparators(value).toLowerCase();
    return native.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`));
  };
  const isWindowsShaped = (value: unknown): value is string => typeof value === 'string'
    && !isNative(value) && (UNC_PATH.test(normalizeSeparators(value)) || DRIVE_PATH.test(normalizeSeparators(value)));

  // Casing comes from the entries that exist, so an unsuccessful lookup never decides a later name.
  const listDirectory = fs.readdirSync;
  const entries = (directory: string): string[] => {
    try { return listDirectory(directory); } catch { return []; }
  };
  const resolveSegments = (directory: string, segments: string[], caseSensitive: boolean): string => {
    let current = directory;
    for (const segment of segments) {
      const names = entries(current);
      const existing = names.find(name => name.toLowerCase() === segment.toLowerCase());
      if (caseSensitive && existing !== undefined && existing !== segment && !names.includes(segment)) {
        throw new Error(`WindowsHostFS cannot model case-distinct Linux paths on every host: ${segment} vs ${existing}`);
      }
      current = path.join(current, caseSensitive ? segment : existing ?? segment);
    }
    return current;
  };
  const toLocal = (value: string): string => {
    if (!isWindowsShaped(value)) return value;
    const normalized = normalizeSeparators(value);
    const unc = UNC_PATH.exec(normalized);
    const [tree, rest, caseSensitive] = unc
      ? [`distro-${unc[1]}`, unc[2] ?? '/', true]
      : [`drive-${DRIVE_PATH.exec(normalized)![1].toUpperCase()}`, DRIVE_PATH.exec(normalized)![2] ?? '/', false];
    // Distro names match case-insensitively; directory names avoid characters NTFS rejects.
    return resolveSegments(resolveSegments(root, [tree], false), rest.split('/').filter(Boolean), caseSensitive);
  };
  const toHost = (localPath: string): string => {
    const relative = path.relative(root, localPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return localPath;
    const [tree, ...rest] = relative.split(path.sep);
    return tree.startsWith('drive-')
      ? `${tree.slice('drive-'.length)}:\\${rest.join('\\')}`
      : `\\\\wsl$\\${[tree.slice('distro-'.length), ...rest].join('\\')}`;
  };

  const originals = [modules.fs, modules.fsPromises].map(module => ({ ...module }));
  const wrap = (module: object, listed: ReadonlySet<string>, label: string) => {
    for (const [name, original] of Object.entries(module)) {
      // Classes (Stats, Dirent, streams) and nested namespaces stay as they are.
      if (typeof original !== 'function' || /^[A-Z]/u.test(name)) continue;
      const replacement = (...args: unknown[]) => {
        if (!listed.has(name)) {
          if (args.some(isWindowsShaped)) throw new Error(`WindowsHostFS does not model ${label}.${name}; add it to the redirected functions`);
          return Reflect.apply(original, module, args);
        }
        const pathCount = PATH_ARGUMENT_COUNT[name] ?? 1;
        const mapped = args.map((arg, index) => index < pathCount && typeof arg === 'string' ? toLocal(arg) : arg);
        const result = Reflect.apply(original, module, mapped);
        if (!RETURNS_PATH.has(name)) return result;
        // fs/promises comes from the host realm, so its promises fail a VM-realm `instanceof Promise`.
        return isThenable(result) ? result.then(value => toHost(String(value))) : toHost(String(result));
      };
      // Keep properties such as realpathSync.native, which host-path containment reads.
      Reflect.set(module, name, Object.assign(replacement, original));
    }
  };
  wrap(modules.fs, FS_FUNCTIONS, 'fs');
  wrap(modules.fsPromises, FS_PROMISES_FUNCTIONS, 'fs/promises');
  onTestFinished(() => {
    for (const [index, module] of [modules.fs, modules.fsPromises].entries()) Object.assign(module, originals[index]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fromLinux = (linuxPath: string, distro = 'Ubuntu'): string => {
    const mounted = MOUNTED_DRIVE.exec(linuxPath);
    return mounted
      ? `${mounted[1].toUpperCase()}:${(mounted[2] ?? '\\').replaceAll('/', '\\')}`
      : `\\\\wsl$\\${distro}${linuxPath.replaceAll('/', '\\')}`;
  };
  const local = (hostPath: string): string => {
    if (!isWindowsShaped(hostPath)) throw new Error(`Not a modeled Windows host path: ${hostPath}`);
    return toLocal(hostPath);
  };
  return {
    /** The Windows host path of a Linux path in a distro; `/mnt/<drive>/…` is the Windows drive file. */
    fromLinux,
    /** The local file standing in for a Windows host path, for test setup such as symlinks. */
    local,
    async write(hostPath: string, content: string): Promise<void> {
      await fs.promises.mkdir(path.dirname(local(hostPath)), { recursive: true });
      await fs.promises.writeFile(local(hostPath), content);
    },
    read: (hostPath: string) => fs.promises.readFile(local(hostPath), 'utf8'),
    remove: (hostPath: string) => fs.promises.rm(local(hostPath), { recursive: true, force: true }),
  };
}

function normalizeSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}
