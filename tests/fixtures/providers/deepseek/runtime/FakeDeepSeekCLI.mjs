/* global process, setInterval, setTimeout, URL */
// Stand-in for the native `dsh` CLI, driven by FAKE_DSH_* variables in its launch environment.
// `--version` prints the version; otherwise it loads the lifecycle plugin named by `--patch`, as native does,
// and prints its launch URL across stdout chunks while staying alive until its owner's stdin closes.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args })}\n`);

if (args.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_DSH_VERSION ?? '0.2.0-rc.2'}\n`);
} else {
  const patch = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
  const lifecycle = patch.find(entry => entry.insert).insert.find(plugin => plugin.id === 'claudian-lifecycle');
  (await import(pathToFileURL(lifecycle.name).href)).apply();
  const mode = process.env.FAKE_DSH_MODE;
  if (mode === 'exit') {
    process.stderr.write('profile failed to load\n');
    process.exit(3);
  }
  setInterval(() => {}, 1000);
  if (mode === 'serve') {
    // FAKE_DSH_SPLIT is the offset into the URL where the first chunk ends (default: after the origin).
    const url = process.env.FAKE_DSH_URL;
    const split = Number(process.env.FAKE_DSH_SPLIT ?? new URL(url).origin.length);
    process.stderr.write('loading MCP servers\n');
    process.stdout.write(`dsh web listening on ${url.slice(0, split)}`);
    setTimeout(() => process.stdout.write(`${url.slice(split)}\n`), 50);
  }
}
