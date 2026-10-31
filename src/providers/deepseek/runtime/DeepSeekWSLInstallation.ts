import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { probeTargetCLIInstallation, type TargetCLIInstallationProbeOptions } from '@/core/providers/cli/TargetCLIInstallationProbe';

export const DEEPSEEK_WSL_INSTALLATION_HELP = 'WSL requires Linux Node.js and the npm @deepseek-ai/dsh package inside the selected distro. DeepSeek Harness Desktop is a Windows/macOS application and cannot supply a WSL installation. Install dsh in that distro and configure its native Web profile, or select the native Windows installation.';

/** npm's Linux bin is a symlink into @deepseek-ai/dsh; resolve its declared package entry inside Linux. */
const RESOLVE_PACKAGE_ENTRY = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let directory = path.dirname(fs.realpathSync(process.argv[1]));
for (;;) {
  const manifest = path.join(directory, 'package.json');
  if (fs.existsSync(manifest)) {
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name === '@deepseek-ai/dsh') {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh;
      if (typeof bin !== 'string') process.exit(1);
      const entry = path.resolve(directory, bin);
      if (!fs.statSync(entry).isFile()) process.exit(1);
      process.stdout.write(JSON.stringify(entry));
      process.exit(0);
    }
  }
  const parent = path.dirname(directory);
  if (parent === directory) process.exit(1);
  directory = parent;
}
`;

export async function probeDeepSeekWSLInstallation(options: Omit<TargetCLIInstallationProbeOptions, 'args'>): Promise<{
  installation: CLIInstallation; nodePath?: string; entryPath?: string;
}> {
  const missing = { installation: { path: null, version: null, source: 'auto' as const } };
  const installation = await probeTargetCLIInstallation({ ...options, args: ['--version'] });
  if (!installation.path || /\.(?:exe|cmd|ps1)$/iu.test(installation.path)) return missing;
  const node = await probeTargetCLIInstallation({ ...options, command: 'node', configuredPath: '', args: ['--version'] });
  if (!node.path || /\.(?:exe|cmd|ps1)$/iu.test(node.path)) return missing;
  const spec = buildTargetLaunchSpec({ ...options, command: node.path, args: ['-e', RESOLVE_PACKAGE_ENTRY, installation.path] });
  const output = await runProcessProbe({ ...spec, cwd: spec.spawnCwd });
  let entryPath: unknown;
  try { entryPath = JSON.parse(output ?? 'null'); } catch { return missing; }
  if (typeof entryPath !== 'string' || !entryPath.startsWith('/')) return missing;
  return { installation, nodePath: node.path, entryPath };
}
