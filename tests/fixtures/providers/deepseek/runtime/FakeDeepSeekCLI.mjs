/* global process, setInterval, setTimeout, URL */
// Stand-in for the native `dsh` CLI, driven by FAKE_DSH_* variables in its launch environment.
// It loads the lifecycle plugin named by `--patch`, as native does, and prints its launch URL across stdout chunks
// while staying alive until its owner's stdin closes.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args })}\n`);

// Like native runProfile, SIGTERM runs a bounded interrupt. A delivered signal names itself; an emitted one does not.
process.on('SIGTERM', signal => {
  if (process.env.FAKE_DSH_INTERRUPTS) appendFileSync(process.env.FAKE_DSH_INTERRUPTS, `${JSON.stringify({ pid: process.pid, by: signal ?? 'owner' })}\n`);
  process.exit(0);
});
const mode = process.env.FAKE_DSH_MODE;
const patch = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
const lifecycle = patch.find(entry => entry.insert).insert.find(plugin => plugin.id === 'claudian-lifecycle');
// `untethered` stands in for a Host whose lifecycle plugin never ends it.
if (mode !== 'untethered') (await import(pathToFileURL(lifecycle.name).href)).apply();
if (mode === 'exit') {
  process.stderr.write('profile failed to load\n');
  process.exit(3);
}
setInterval(() => {}, 1000);
if (mode === 'serve' || mode === 'untethered') {
  // FAKE_DSH_SPLIT is the offset into the URL where the first chunk ends (default: after the origin).
  const url = process.env.FAKE_DSH_URL;
  const split = Number(process.env.FAKE_DSH_SPLIT ?? new URL(url).origin.length);
  process.stderr.write('loading MCP servers\n');
  process.stdout.write(`dsh web listening on ${url.slice(0, split)}`);
  setTimeout(() => process.stdout.write(`${url.slice(split)}${process.env.FAKE_DSH_EOL ?? '\n'}`), 50);
}
