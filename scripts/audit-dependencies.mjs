import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Advisories accepted until upstream ships a compatible fix. Each entry names its exit condition.
export const acceptedAdvisories = new Map([
  // minimatch < 11.0.1 (ReDoS). It reaches only ESLint tooling; the newest ESLint packages still
  // require minimatch ^3 or ^10. Remove once they accept minimatch >= 11.0.1.
  ['GHSA-g3hv-75wg-m249', 'dev-only ESLint dependency without a compatible fix'],
]);

const severities = ['info', 'low', 'moderate', 'high', 'critical'];

const advisoryId = url => url?.match(/GHSA-[\w-]+$/)?.[0];

/** Lists audited packages at or above the threshold that remain vulnerable without the accepted advisories. */
export function unacceptedVulnerabilities(report, accepted = acceptedAdvisories, threshold = 'moderate') {
  const vulnerabilities = report.vulnerabilities ?? {};
  const memo = new Map();
  // A package is vulnerable when it has an unaccepted advisory or depends on a package that does.
  const vulnerable = (name, seen = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name)) return false;
    seen.add(name);
    const result = (vulnerabilities[name]?.via ?? []).some(via => (typeof via === 'string'
      ? vulnerable(via, seen)
      : !accepted.has(advisoryId(via.url))));
    memo.set(name, result);
    return result;
  };
  return Object.entries(vulnerabilities)
    .filter(([name, entry]) => severities.indexOf(entry.severity) >= severities.indexOf(threshold) && vulnerable(name))
    .map(([name, entry]) => ({ name, severity: entry.severity }));
}

function main() {
  const audit = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    process.stderr.write(`npm audit did not return JSON:\n${audit.stdout}${audit.stderr}`);
    process.exit(1);
  }
  if (report.error) {
    process.stderr.write(`npm audit failed: ${JSON.stringify(report.error)}\n`);
    process.exit(1);
  }
  const remaining = unacceptedVulnerabilities(report);
  for (const [id, reason] of acceptedAdvisories) process.stdout.write(`Accepted ${id}: ${reason}\n`);
  if (remaining.length > 0) {
    process.stderr.write(`Unaccepted vulnerabilities:\n${remaining.map(({ name, severity }) => `  ${name} (${severity})`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('No unaccepted moderate or higher vulnerabilities.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
