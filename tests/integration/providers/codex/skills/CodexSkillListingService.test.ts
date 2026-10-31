import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import { updateCodexProviderSettings } from '@/providers/codex/settings';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

const native = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn((command: string) => native.createProcess(
  command === 'wsl.exe' ? { platformFamily: 'unix', platformOs: 'linux' } : undefined,
)) }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let vault: DesktopVault;
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let runtime: CodexAppServerRuntime;
let service: CodexSkillListingService;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });
beforeEach(async () => {
  native.reset();
  native.autoReconcile = true;
  native.holdSkills = true;
  fixture = await createProviderHostFixture({
    vault, settings: { providerConfigs: { codex: { enabled: true } } },
    overrides: { getResolvedProviderCliPath: async () => '/native/codex' },
  });
  runtime = new CodexAppServerRuntime(fixture.host.getRuntimeHost('codex'), () => undefined);
  service = new CodexSkillListingService(runtime);
});
afterEach(async () => {
  await service.dispose();
  await runtime.dispose();
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

function makeSkill(name: string): SkillMetadata {
  return { name, description: `${name} description`, path: `/tmp/${name}/SKILL.md`, scope: 'repo', enabled: true };
}

async function waitForListing(count = 1) {
  const process = await native.waitForRequest('skills/list', 0, count);
  const request = process.requests.filter(request => request.method === 'skills/list')[count - 1];
  return {
    process, request,
    respond(skills: SkillMetadata[], cwd = vault.root) { process.respond(request.id, { data: [{ cwd, skills }] }); },
  };
}
function listingCount() { return native.processes.flatMap(process => process.requests).filter(request => request.method === 'skills/list').length; }

it('does not join a listing from before invalidation', async () => {
  const stale = service.listSkills();
  const old = await waitForListing();
  service.invalidate();
  const fresh = service.listSkills();
  const next = await waitForListing(2);
  next.respond([makeSkill('fresh')]);
  await expect(fresh).resolves.toEqual([makeSkill('fresh')]);
  old.respond([makeSkill('stale')]);
  await expect(stale).resolves.toEqual([makeSkill('stale')]);
  expect(listingCount()).toBe(2);
});

it.each(['success', 'failure'] as const)('quiesces a held listing before a late native %s response', async outcome => {
  const stale = service.listSkills();
  const old = await waitForListing();
  let settled = false;
  const staleOutcome = stale.then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await service.quiesceForEnvironmentChange();
  expect(settled).toBe(true);
  await expect(staleOutcome).resolves.toMatchObject({ message: 'Request aborted: skills/list' });
  expect(old.process.isAlive()).toBe(true);

  if (outcome === 'failure') old.process.respondError(old.request.id, 'Late listing failure');
  else old.respond([makeSkill('stale')]);
  const fresh = service.listSkills();
  const next = await waitForListing(2);
  next.respond([makeSkill('fresh')]);
  await expect(fresh).resolves.toEqual([makeSkill('fresh')]);
  expect(listingCount()).toBe(2);
});

it('blocks skill listing during an environment transition and reloads from the new state', async () => {
  const initial = service.listSkills();
  (await waitForListing()).respond([makeSkill('old')]);
  await expect(initial).resolves.toEqual([makeSkill('old')]);
  service.beginEnvironmentTransition();
  await service.quiesceForEnvironmentChange();
  const listing = service.listSkills();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(listingCount()).toBe(1);
    service.endEnvironmentTransition();
    (await waitForListing(2)).respond([makeSkill('new')]);
    await expect(listing).resolves.toEqual([makeSkill('new')]);
  } finally { service.endEnvironmentTransition(); }
  expect(listingCount()).toBe(2);
});

it('releases transition-blocked skill requests without starting a probe on disposal', async () => {
  service.beginEnvironmentTransition();
  const listing = service.listSkills();
  await service.dispose();
  await expect(listing).resolves.toEqual([]);
  expect(native.processes).toEqual([]);
});

it('keeps the forced request available for coalescing when an older request finishes', async () => {
  const stale = service.listSkills();
  const old = await waitForListing();
  // Hold the separate plugin refresh: its completion correctly invalidates all pending listings.
  native.autoReconcile = false;
  const fresh = service.listSkills({ forceReload: true });
  const next = await waitForListing(2);
  old.respond([makeSkill('stale')]);
  await stale;
  const joined = service.listSkills();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(listingCount()).toBe(2);
  next.respond([makeSkill('fresh')]);
  await expect(fresh).resolves.toEqual([makeSkill('fresh')]);
  await expect(joined).resolves.toEqual([makeSkill('fresh')]);
  next.process.completeReconcile();
});

it('coalesces a normal request behind an in-flight forced refresh', async () => {
  const forced = service.listSkills({ forceReload: true });
  const normal = service.listSkills();
  const listing = await waitForListing();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(listingCount()).toBe(1);
  expect(listing.request.params).toMatchObject({ forceReload: true });
  expect(listing.process.requests.filter(request => request.method === 'plugin/reconcile')).toHaveLength(2);
  listing.respond([makeSkill('fresh')]);
  await expect(forced).resolves.toEqual([makeSkill('fresh')]);
  await expect(normal).resolves.toEqual([makeSkill('fresh')]);
  expect(listingCount()).toBe(1);
});

it('uses the WSL target cwd for native listing and maps returned skill paths back to the host', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  Object.defineProperty(fixture.host, 'workingDirectory', { value: 'C:\\repo', configurable: true });
  updateCodexProviderSettings(fixture.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
  const pending = service.listSkills({ forceReload: true });
  const listing = await waitForListing();
  listing.respond([{ ...makeSkill('review'), path: '/mnt/c/repo/.codex/skills/review/SKILL.md' }], '/mnt/c/repo');
  await expect(pending).resolves.toEqual([{ ...makeSkill('review'), path: 'C:\\repo\\.codex\\skills\\review\\SKILL.md' }]);
  expect(listing.request.params).toEqual({ cwds: ['/mnt/c/repo'], forceReload: true });
  // A completed listing releases its lease, allowing the old process to retire.
  fixture.settings.providerConfigs.codex!.environmentVariables = 'KEY=replacement';
  const replacement = await runtime.acquire();
  expect(listing.process.isAlive()).toBe(false);
  await replacement.release();
});
