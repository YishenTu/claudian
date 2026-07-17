import * as fs from 'fs';
import * as path from 'path';

import type { CodexRuntimeContext } from './CodexRuntimeContext';

const RUNTIME_DEPENDENCY_ENV_KEYS = [
  'CODEX_RUNTIME_DEPENDENCIES',
  'CODEX_WORKSPACE_DEPENDENCIES',
  'CODEX_DEPENDENCIES',
] as const;

interface RuntimeManifest {
  bundleVersion?: unknown;
  targetPlatform?: unknown;
}

interface PackageManifest {
  version?: unknown;
}

export interface CodexWorkspaceDependencies {
  bundleVersion: string;
  artifactToolVersion: string;
  runtimeRoot: string;
  dependenciesRoot: string;
  gitExecutable: string | null;
  nodeExecutable: string;
  nodePackages: string;
  pnpmExecutable: string | null;
  pythonExecutable: string;
  pythonPackages: string;
  overrideBinaries: string;
  fallbackBinaries: string;
}

function targetPathApi(context: CodexRuntimeContext): typeof path.posix | typeof path.win32 {
  return context.launchSpec.target.platformFamily === 'windows' ? path.win32 : path.posix;
}

function normalizeTargetPath(context: CodexRuntimeContext, value: string): string {
  const targetPath = targetPathApi(context);
  return targetPath === path.posix
    ? targetPath.normalize(value.replace(/\\/g, '/'))
    : targetPath.normalize(value);
}

function joinTargetPath(context: CodexRuntimeContext, ...parts: string[]): string {
  const targetPath = targetPathApi(context);
  return targetPath === path.posix
    ? targetPath.join(...parts.map(part => part.replace(/\\/g, '/')))
    : targetPath.join(...parts);
}

function readEnvironmentValue(
  environment: Record<string, string>,
  key: string,
): string | undefined {
  const exact = environment[key]?.trim();
  if (exact) return exact;

  const matchingKey = Object.keys(environment).find(
    candidate => candidate.toLowerCase() === key.toLowerCase(),
  );
  const value = matchingKey ? environment[matchingKey]?.trim() : undefined;
  return value || undefined;
}

function environmentPathToTarget(
  context: CodexRuntimeContext,
  value: string,
): string | null {
  if (context.launchSpec.target.method !== 'wsl') {
    return normalizeTargetPath(context, value);
  }

  if (value.startsWith('/')) {
    return normalizeTargetPath(context, value);
  }

  const targetPath = context.launchSpec.pathMapper.toTargetPath(value);
  return targetPath ? normalizeTargetPath(context, targetPath) : null;
}

function resolveTargetHome(context: CodexRuntimeContext): string | null {
  if (context.launchSpec.target.method !== 'wsl') {
    const homeKey = context.launchSpec.target.platformFamily === 'windows'
      ? 'USERPROFILE'
      : 'HOME';
    const home = readEnvironmentValue(context.launchSpec.env, homeKey);
    if (home) return normalizeTargetPath(context, home);
  }

  const codexHome = context.codexHomeTarget;
  if (!codexHome) return null;

  const targetPath = targetPathApi(context);
  return targetPath.basename(codexHome).toLowerCase() === '.codex'
    ? targetPath.dirname(codexHome)
    : null;
}

function resolveDependencyCandidates(context: CodexRuntimeContext): Array<{
  runtimeRoot: string;
  dependenciesRoot: string;
}> {
  const candidates: Array<{ runtimeRoot: string; dependenciesRoot: string }> = [];
  const seen = new Set<string>();
  const addCandidate = (dependenciesRoot: string): void => {
    const normalizedDependencies = normalizeTargetPath(context, dependenciesRoot);
    if (seen.has(normalizedDependencies)) return;
    seen.add(normalizedDependencies);
    candidates.push({
      runtimeRoot: targetPathApi(context).dirname(normalizedDependencies),
      dependenciesRoot: normalizedDependencies,
    });
  };

  for (const key of RUNTIME_DEPENDENCY_ENV_KEYS) {
    const configuredPath = readEnvironmentValue(context.launchSpec.env, key);
    const targetPath = configuredPath
      ? environmentPathToTarget(context, configuredPath)
      : null;
    if (targetPath) addCandidate(targetPath);
  }

  const targetHome = resolveTargetHome(context);
  if (targetHome) {
    addCandidate(joinTargetPath(
      context,
      targetHome,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
    ));
  }

  return candidates;
}

function toHostPath(context: CodexRuntimeContext, targetPath: string): string | null {
  return context.launchSpec.pathMapper.toHostPath(targetPath);
}

async function isFile(context: CodexRuntimeContext, targetPath: string): Promise<boolean> {
  const hostPath = toHostPath(context, targetPath);
  if (!hostPath) return false;
  try {
    return (await fs.promises.stat(hostPath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(context: CodexRuntimeContext, targetPath: string): Promise<boolean> {
  const hostPath = toHostPath(context, targetPath);
  if (!hostPath) return false;
  try {
    return (await fs.promises.stat(hostPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson<T>(
  context: CodexRuntimeContext,
  targetPath: string,
): Promise<T | null> {
  const hostPath = toHostPath(context, targetPath);
  if (!hostPath) return null;
  try {
    return JSON.parse(await fs.promises.readFile(hostPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function expectedManifestPlatform(context: CodexRuntimeContext): string {
  switch (context.launchSpec.target.platformOs) {
    case 'macos':
      return 'darwin';
    case 'windows':
      return 'win32';
    default:
      return 'linux';
  }
}

function executableNames(
  context: CodexRuntimeContext,
  name: string,
): string[] {
  return context.launchSpec.target.platformFamily === 'windows'
    ? [`${name}.exe`, `${name}.cmd`, name]
    : [name];
}

async function findFile(
  context: CodexRuntimeContext,
  directory: string,
  names: string[],
): Promise<string | null> {
  for (const name of names) {
    const candidate = joinTargetPath(context, directory, name);
    if (await isFile(context, candidate)) return candidate;
  }
  return null;
}

async function findBundledCommand(
  context: CodexRuntimeContext,
  dependenciesRoot: string,
  name: string,
): Promise<string | null> {
  const directories = [
    joinTargetPath(context, dependenciesRoot, 'bin', 'override'),
    joinTargetPath(context, dependenciesRoot, 'bin', 'fallback'),
    joinTargetPath(context, dependenciesRoot, 'bin'),
  ];
  const names = executableNames(context, name);

  for (const directory of directories) {
    const executable = await findFile(context, directory, names);
    if (executable) return executable;
  }
  return null;
}

async function resolveCandidate(
  context: CodexRuntimeContext,
  candidate: { runtimeRoot: string; dependenciesRoot: string },
): Promise<CodexWorkspaceDependencies | null> {
  const manifest = await readJson<RuntimeManifest>(
    context,
    joinTargetPath(context, candidate.runtimeRoot, 'runtime.json'),
  );
  if (
    !manifest
    || typeof manifest.bundleVersion !== 'string'
    || !manifest.bundleVersion.trim()
    || (
      typeof manifest.targetPlatform === 'string'
      && manifest.targetPlatform !== expectedManifestPlatform(context)
    )
  ) {
    return null;
  }

  const nodeRoot = joinTargetPath(context, candidate.dependenciesRoot, 'node');
  const nodePackages = joinTargetPath(context, nodeRoot, 'node_modules');
  const pythonPackages = joinTargetPath(context, candidate.dependenciesRoot, 'python');
  const overrideBinaries = joinTargetPath(context, candidate.dependenciesRoot, 'bin', 'override');
  const fallbackBinaries = joinTargetPath(context, candidate.dependenciesRoot, 'bin', 'fallback');
  const artifactManifestPath = joinTargetPath(
    context,
    nodePackages,
    '@oai',
    'artifact-tool',
    'package.json',
  );

  const nodeExecutable = await findFile(
    context,
    joinTargetPath(context, nodeRoot, 'bin'),
    executableNames(context, 'node'),
  );
  const pythonExecutable = await findFile(
    context,
    joinTargetPath(context, pythonPackages, 'bin'),
    context.launchSpec.target.platformFamily === 'windows'
      ? ['python.exe', 'python3.exe', 'python']
      : ['python3', 'python'],
  ) ?? await findFile(
    context,
    pythonPackages,
    context.launchSpec.target.platformFamily === 'windows' ? ['python.exe'] : [],
  );
  const artifactManifest = await readJson<PackageManifest>(context, artifactManifestPath);
  const requiredDirectoriesExist = await Promise.all([
    isDirectory(context, nodePackages),
    isDirectory(context, pythonPackages),
    isDirectory(context, overrideBinaries),
    isDirectory(context, fallbackBinaries),
  ]);

  if (
    !nodeExecutable
    || !pythonExecutable
    || requiredDirectoriesExist.some(exists => !exists)
    || !artifactManifest
    || typeof artifactManifest.version !== 'string'
    || !artifactManifest.version.trim()
  ) {
    return null;
  }

  return {
    bundleVersion: manifest.bundleVersion,
    artifactToolVersion: artifactManifest.version,
    runtimeRoot: candidate.runtimeRoot,
    dependenciesRoot: candidate.dependenciesRoot,
    gitExecutable: await findBundledCommand(context, candidate.dependenciesRoot, 'git'),
    nodeExecutable,
    nodePackages,
    pnpmExecutable: await findBundledCommand(context, candidate.dependenciesRoot, 'pnpm'),
    pythonExecutable,
    pythonPackages,
    overrideBinaries,
    fallbackBinaries,
  };
}

export async function resolveCodexWorkspaceDependencies(
  context: CodexRuntimeContext,
): Promise<CodexWorkspaceDependencies | null> {
  for (const candidate of resolveDependencyCandidates(context)) {
    const dependencies = await resolveCandidate(context, candidate);
    if (dependencies) return dependencies;
  }
  return null;
}

export function formatCodexWorkspaceDependencies(
  dependencies: CodexWorkspaceDependencies,
): string {
  const lines = [
    'Workspace dependencies are available for this local Claudian Codex thread.',
    '',
    '### Workspace Dependencies',
    'Use these bundled paths for sheets, slides, documents, PDFs, images, or browser automation:',
    `- Bundle version: \`${dependencies.bundleVersion}\``,
    `- Artifact tool version: \`${dependencies.artifactToolVersion}\``,
  ];

  if (dependencies.gitExecutable) {
    lines.push(`- Git executable: \`${dependencies.gitExecutable}\``);
  }
  lines.push(
    `- Node.js executable: \`${dependencies.nodeExecutable}\``,
    `- Node.js packages: \`${dependencies.nodePackages}\``,
  );
  if (dependencies.pnpmExecutable) {
    lines.push(`- pnpm executable: \`${dependencies.pnpmExecutable}\``);
  }
  lines.push(
    `- Python executable: \`${dependencies.pythonExecutable}\``,
    `- Python packages: \`${dependencies.pythonPackages}\``,
    `- Override binaries: \`${dependencies.overrideBinaries}\``,
    `- Fallback binaries: \`${dependencies.fallbackBinaries}\``,
  );

  return lines.join('\n');
}
