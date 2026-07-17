import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CodexRuntimeContext } from '@/providers/codex/runtime/CodexRuntimeContext';
import {
  formatCodexWorkspaceDependencies,
  resolveCodexWorkspaceDependencies,
} from '@/providers/codex/runtime/CodexWorkspaceDependencyResolver';

function createRuntimeBundle(home: string): string {
  const runtimeRoot = path.join(
    home,
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
  );
  const dependenciesRoot = path.join(runtimeRoot, 'dependencies');

  fs.mkdirSync(path.join(dependenciesRoot, 'node', 'bin'), { recursive: true });
  fs.mkdirSync(
    path.join(dependenciesRoot, 'node', 'node_modules', '@oai', 'artifact-tool'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(dependenciesRoot, 'python', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dependenciesRoot, 'bin', 'override'), { recursive: true });
  fs.mkdirSync(path.join(dependenciesRoot, 'bin', 'fallback'), { recursive: true });

  fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
    bundleFormatVersion: 2,
    bundleVersion: '26.715.12143',
    targetPlatform: 'darwin',
  }));
  fs.writeFileSync(path.join(dependenciesRoot, 'node', 'bin', 'node'), '');
  fs.writeFileSync(path.join(dependenciesRoot, 'python', 'bin', 'python3'), '');
  fs.writeFileSync(path.join(dependenciesRoot, 'bin', 'fallback', 'git'), '');
  fs.writeFileSync(path.join(dependenciesRoot, 'bin', 'fallback', 'pnpm'), '');
  fs.writeFileSync(
    path.join(dependenciesRoot, 'node', 'node_modules', '@oai', 'artifact-tool', 'package.json'),
    JSON.stringify({ version: '2.8.24' }),
  );

  return runtimeRoot;
}

function createHostRuntimeContext(
  home: string,
  env: Record<string, string> = { HOME: home },
): CodexRuntimeContext {
  const target = {
    method: 'host-native' as const,
    platformFamily: 'unix' as const,
    platformOs: 'macos' as const,
  };

  return {
    launchSpec: {
      target,
      command: 'codex',
      args: [],
      spawnCwd: '/vault',
      targetCwd: '/vault',
      env,
      pathMapper: {
        target,
        toTargetPath: value => value,
        toHostPath: value => value,
        mapTargetPathList: values => values,
        canRepresentHostPath: () => true,
      },
    },
    initializeResult: {
      userAgent: 'test',
      codexHome: path.join(home, '.codex'),
      platformFamily: 'unix',
      platformOs: 'macos',
    },
    codexHomeTarget: path.join(home, '.codex'),
    codexHomeHost: path.join(home, '.codex'),
    sessionsDirTarget: path.join(home, '.codex', 'sessions'),
    sessionsDirHost: path.join(home, '.codex', 'sessions'),
    memoriesDirTarget: path.join(home, '.codex', 'memories'),
  };
}

describe('CodexWorkspaceDependencyResolver', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves and describes the validated primary runtime bundle', async () => {
    const runtimeRoot = createRuntimeBundle(tempDir);

    const result = await resolveCodexWorkspaceDependencies(
      createHostRuntimeContext(tempDir),
    );

    expect(result).toEqual(expect.objectContaining({
      bundleVersion: '26.715.12143',
      artifactToolVersion: '2.8.24',
      runtimeRoot,
      nodeExecutable: path.join(runtimeRoot, 'dependencies', 'node', 'bin', 'node'),
      nodePackages: path.join(runtimeRoot, 'dependencies', 'node', 'node_modules'),
      pythonExecutable: path.join(runtimeRoot, 'dependencies', 'python', 'bin', 'python3'),
      pythonPackages: path.join(runtimeRoot, 'dependencies', 'python'),
      gitExecutable: path.join(runtimeRoot, 'dependencies', 'bin', 'fallback', 'git'),
      pnpmExecutable: path.join(runtimeRoot, 'dependencies', 'bin', 'fallback', 'pnpm'),
    }));

    expect(formatCodexWorkspaceDependencies(result!)).toContain(
      `- Node.js packages: \`${path.join(runtimeRoot, 'dependencies', 'node', 'node_modules')}\``,
    );
  });

  it('prefers an explicitly configured dependency root', async () => {
    const defaultHome = path.join(tempDir, 'default-home');
    const explicitHome = path.join(tempDir, 'explicit-home');
    createRuntimeBundle(defaultHome);
    const explicitRuntimeRoot = createRuntimeBundle(explicitHome);
    const explicitDependencies = path.join(explicitRuntimeRoot, 'dependencies');

    const result = await resolveCodexWorkspaceDependencies(createHostRuntimeContext(
      defaultHome,
      {
        HOME: defaultHome,
        CODEX_RUNTIME_DEPENDENCIES: explicitDependencies,
      },
    ));

    expect(result?.runtimeRoot).toBe(explicitRuntimeRoot);
  });

  it('does not expose a partial bundle without artifact-tool', async () => {
    const runtimeRoot = createRuntimeBundle(tempDir);
    fs.rmSync(
      path.join(runtimeRoot, 'dependencies', 'node', 'node_modules', '@oai', 'artifact-tool'),
      { recursive: true },
    );

    await expect(resolveCodexWorkspaceDependencies(
      createHostRuntimeContext(tempDir),
    )).resolves.toBeNull();
  });

  it('returns target paths while validating mapped host paths for WSL', async () => {
    const runtimeRoot = createRuntimeBundle(tempDir);
    const targetHome = '/home/tester';
    const targetRuntimeRoot = `${targetHome}/.cache/codex-runtimes/codex-primary-runtime`;
    const context = createHostRuntimeContext(tempDir) as CodexRuntimeContext;
    context.launchSpec.target = {
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    };
    context.launchSpec.pathMapper.target = context.launchSpec.target;
    context.launchSpec.pathMapper.toHostPath = value => value.replace(targetRuntimeRoot, runtimeRoot);
    context.launchSpec.pathMapper.toTargetPath = value => value.replace(runtimeRoot, targetRuntimeRoot);
    context.launchSpec.env = {};
    context.initializeResult = {
      userAgent: 'test',
      codexHome: `${targetHome}/.codex`,
      platformFamily: 'unix',
      platformOs: 'linux',
    };
    context.codexHomeTarget = `${targetHome}/.codex`;
    context.codexHomeHost = path.join(tempDir, '.codex');
    fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      bundleFormatVersion: 2,
      bundleVersion: '26.715.12143',
      targetPlatform: 'linux',
    }));

    const result = await resolveCodexWorkspaceDependencies(context);

    expect(result?.runtimeRoot).toBe(targetRuntimeRoot);
    expect(result?.nodePackages).toBe(`${targetRuntimeRoot}/dependencies/node/node_modules`);
  });
});
