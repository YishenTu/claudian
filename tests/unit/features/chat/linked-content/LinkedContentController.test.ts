import { TFile, TFolder } from 'obsidian';

import {
  LinkedContentController,
  type LinkedContentControllerOptions,
} from '@/features/chat/linked-content/LinkedContentController';

function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function createHarness(initialFiles: Array<TFile | TFolder> = []) {
  const entries = new Map(initialFiles.map(entry => [entry.path || '.', entry]));
  let activeFile: TFile | null = null;
  const app = {
    vault: {
      getRoot: jest.fn(() => createFolder('')),
      getAbstractFileByPath: jest.fn((path: string) => entries.get(path) ?? null),
    },
    workspace: {
      getActiveFile: jest.fn(() => activeFile),
      getLeaf: jest.fn(() => ({ openFile: jest.fn().mockResolvedValue(undefined) })),
      getLeavesOfType: jest.fn(() => []),
      getLeftLeaf: jest.fn(() => null),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    },
    metadataCache: {
      getFileCache: jest.fn(() => null),
    },
  };
  const options: LinkedContentControllerOptions = {
    app: app as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [...entries.values()].filter(
      (entry): entry is TFile => entry instanceof TFile,
    ),
    getCachedVaultFolders: () => [...entries.values()].filter(
      (entry): entry is TFolder => entry instanceof TFolder,
    ),
  };

  return {
    app,
    controller: new LinkedContentController(options),
    entries,
    setActiveFile(file: TFile | null) {
      activeFile = file;
    },
  };
}

describe('LinkedContentController', () => {
  it('follows eligible active Notes only in auto-draft and keeps explicit choices sticky', () => {
    const first = createFile('Notes/First.md');
    const second = createFile('Notes/Second.md');
    const folder = createFolder('Projects');
    const harness = createHarness([first, second, folder]);

    harness.setActiveFile(first);
    harness.controller.resetAutoDraft();
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'auto-draft',
      path: 'Notes/First.md',
    });

    harness.controller.selectExplicit('Projects');
    harness.controller.handleActiveFileChanged(second, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: 'Projects',
    });

    harness.controller.selectExplicit(null);
    harness.controller.handleActiveFileChanged(first, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });

    harness.controller.resetAutoDraft();
    harness.controller.handleActiveFileChanged(second, false);
    expect(harness.controller.getSnapshot().path).toBe('Notes/First.md');
  });

  it('normalizes every explicit selection through the core Linked content codec', () => {
    const harness = createHarness();

    harness.controller.selectExplicit('Projects\\Research//./Plan.md');
    expect(harness.controller.getSnapshot().path).toBe('Projects/Research/Plan.md');
    expect(() => harness.controller.selectExplicit('../outside')).toThrow(
      'Invalid Linked content path',
    );
  });

  it('defaults only eligible Markdown Notes and respects excluded tags', () => {
    const markdown = createFile('Notes/Private.md');
    const image = createFile('Images/Diagram.png');
    const harness = createHarness([markdown, image]);
    (harness.app.metadataCache.getFileCache as jest.Mock).mockReturnValue({
      tags: [{ tag: '#private' }],
    });
    const excludedController = new LinkedContentController({
      app: harness.app as never,
      getExcludedTags: () => ['private'],
      getCachedVaultFiles: () => [],
      getCachedVaultFolders: () => [],
    });

    harness.setActiveFile(markdown);
    excludedController.handleActiveFileChanged(markdown, true);
    expect(excludedController.getSnapshot().path).toBeNull();

    excludedController.handleActiveFileChanged(image, true);
    expect(excludedController.getSnapshot().path).toBeNull();
  });

  it('waits for metadata before auto-linking when excluded tags are configured', () => {
    const markdown = createFile('Notes/Startup.md');
    const harness = createHarness([markdown]);
    let cache: unknown = null;
    (harness.app.metadataCache.getFileCache as jest.Mock).mockImplementation(() => cache);
    const controller = new LinkedContentController({
      app: harness.app as never,
      getExcludedTags: () => ['private'],
      getCachedVaultFiles: () => [],
      getCachedVaultFolders: () => [],
    });

    harness.setActiveFile(markdown);
    controller.resetAutoDraft();

    expect(controller.getSnapshot().path).toBeNull();

    cache = { tags: [] };
    controller.handleActiveFileMetadataChanged(markdown);

    expect(controller.getSnapshot().path).toBe('Notes/Startup.md');
  });

  it('unloads the auto-linked active Note when metadata gains an excluded tag', () => {
    const markdown = createFile('Notes/Public.md');
    const harness = createHarness([markdown]);
    let cache: unknown = { tags: [] };
    (harness.app.metadataCache.getFileCache as jest.Mock).mockImplementation(() => cache);
    const controller = new LinkedContentController({
      app: harness.app as never,
      getExcludedTags: () => ['private'],
      getCachedVaultFiles: () => [],
      getCachedVaultFolders: () => [],
    });

    harness.setActiveFile(markdown);
    controller.resetAutoDraft();
    expect(controller.getSnapshot().path).toBe('Notes/Public.md');

    cache = { tags: [{ tag: '#private' }] };
    controller.handleActiveFileMetadataChanged(markdown);

    expect(controller.getSnapshot().path).toBeNull();
  });

  it('creates one immutable path token and locks only after durable creation', () => {
    const harness = createHarness([createFolder('Projects')]);
    harness.controller.selectExplicit('Projects');

    const token = harness.controller.beginSubmission();
    expect(Object.isFrozen(token)).toBe(true);
    expect(token).toEqual({ path: 'Projects' });
    expect(harness.controller.getSnapshot().mode).toBe('submitting');
    expect(() => harness.controller.selectExplicit(null)).toThrow(
      'Linked content cannot be changed while submitting',
    );

    const settlement = harness.controller.commitSubmission(token);
    expect(settlement).toEqual({
      linkedContentPath: 'Projects',
      queuedEvents: [],
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'locked',
      path: 'Projects',
    });
  });

  it('restores the exact draft after create failure', () => {
    const note = createFile('Notes/Draft.md');
    const harness = createHarness([note]);
    harness.setActiveFile(note);
    harness.controller.resetAutoDraft();

    const autoToken = harness.controller.beginSubmission();
    harness.controller.rollbackSubmission(autoToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'auto-draft',
      path: 'Notes/Draft.md',
    });

    harness.controller.selectExplicit(null);
    const noneToken = harness.controller.beginSubmission();
    harness.controller.rollbackSubmission(noneToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });
  });

  it('queues rename and delete without mutating the outgoing token, then converges on success', () => {
    const original = createFolder('Projects/Old');
    const harness = createHarness([original]);
    harness.controller.selectExplicit(original.path);
    const token = harness.controller.beginSubmission();

    harness.controller.handleRenamed('Projects/Old', 'Projects/New', true);
    harness.controller.handleDeleted('Projects/New', true);
    expect(token.path).toBe('Projects/Old');
    expect(harness.controller.getSnapshot().path).toBe('Projects/Old');

    harness.entries.delete('Projects/Old');
    const settlement = harness.controller.commitSubmission(token);
    expect(settlement.linkedContentPath).toBe('Projects/New');
    expect(settlement.queuedEvents).toEqual([
      { kind: 'rename', oldPath: 'Projects/Old', newPath: 'Projects/New', includeDescendants: true },
      { kind: 'delete', path: 'Projects/New', includeDescendants: true },
    ]);
    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'locked',
      path: 'Projects/New',
    });
  });

  it('replays queued events into a restored draft after create failure', () => {
    const harness = createHarness([createFolder('Projects/Old')]);
    harness.controller.selectExplicit('Projects/Old');
    const renameToken = harness.controller.beginSubmission();
    harness.controller.handleRenamed('Projects/Old', 'Projects/New', true);
    harness.controller.rollbackSubmission(renameToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: 'Projects/New',
    });

    const deleteToken = harness.controller.beginSubmission();
    harness.controller.handleDeleted('Projects/New', true);
    harness.controller.rollbackSubmission(deleteToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });
  });

  it('rewrites draft and locked descendants while preserving the locked path after deletion', () => {
    const file = createFile('Projects/Old/Plan.md');
    const harness = createHarness([file]);
    harness.controller.selectExplicit(file.path);

    harness.controller.handleRenamed('Projects/Old', 'Projects/New', true);
    expect(harness.controller.getSnapshot().path).toBe('Projects/New/Plan.md');

    harness.controller.lock('Projects/New/Plan.md');
    harness.controller.handleDeleted('Projects/New', true);
    harness.entries.delete(file.path);
    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'locked',
      path: 'Projects/New/Plan.md',
    });

    const restored = createFile('Projects/New/Plan.md');
    harness.entries.set(restored.path, restored);
    harness.controller.handleCreated(restored.path);
    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'locked',
      path: 'Projects/New/Plan.md',
    });
  });

  it('turns a directly deleted draft target into sticky explicit None', () => {
    const harness = createHarness([createFolder('Projects')]);
    harness.controller.selectExplicit('Projects');

    harness.controller.handleDeleted('Projects', true);

    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });
  });

  it('locks an existing zero-message Conversation by identity without owning history state', () => {
    const harness = createHarness();

    harness.controller.lock(undefined);

    expect(harness.controller.getSnapshot()).toMatchObject({ mode: 'locked', path: null });
    expect(harness.controller).not.toHaveProperty('currentNoteSent');
    expect(harness.controller).not.toHaveProperty('ordinal');
    expect(harness.controller).not.toHaveProperty('history');
  });

  it('ignores stale calls after destruction and rejects stale submission tokens', () => {
    const harness = createHarness();
    harness.controller.selectExplicit('Notes/One.md');
    const token = harness.controller.beginSubmission();
    harness.controller.rollbackSubmission(token);
    const nextToken = harness.controller.beginSubmission();

    expect(() => harness.controller.commitSubmission(token)).toThrow('Stale Linked content submission');

    harness.controller.destroy();
    harness.controller.handleRenamed('Notes/One.md', 'Notes/Two.md');
    expect(() => harness.controller.commitSubmission(nextToken)).toThrow(
      'Linked content controller is destroyed',
    );
  });
});
