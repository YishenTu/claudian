import { type App, Notice, TFile, TFolder } from 'obsidian';

import { openComposerPath } from '@/features/chat/composer/OpenComposerPath';

it.each([true, false])('reveals the selected folder in the file explorer (already open=%s)', async alreadyOpen => {
  const folder = Object.assign(new TFolder(), { path: 'Journals/Pages/Travel' });
  const revealInFolder = jest.fn().mockResolvedValue(undefined);
  const leaf = {
    view: { revealInFolder: alreadyOpen ? revealInFolder : undefined },
    setViewState: async (state: { type: string; active: boolean }) => {
      expect(state).toEqual({ type: 'file-explorer', active: true });
      leaf.view.revealInFolder = revealInFolder;
    },
  };
  const getAbstractFileByPath = jest.fn().mockReturnValue(folder);
  const revealLeaf = jest.fn().mockResolvedValue(undefined);
  const app = {
    vault: { getAbstractFileByPath },
    workspace: {
      getLeavesOfType: () => alreadyOpen ? [leaf] : [],
      getLeftLeaf: () => leaf,
      revealLeaf,
    },
  } as unknown as App;

  await openComposerPath(app, 'Journals/Pages/Travel/');

  expect(getAbstractFileByPath).toHaveBeenCalledWith('Journals/Pages/Travel');
  expect(revealLeaf).toHaveBeenCalledWith(leaf);
  expect(revealInFolder).toHaveBeenCalledWith(folder);
});

it('opens the exact referenced vault file in a note tab and rechecks deleted references', async () => {
  const file = Object.assign(new TFile(), { path: 'Notes/A #1.md' });
  const openFile = jest.fn().mockResolvedValue(undefined);
  const getLeaf = jest.fn().mockReturnValue({ openFile });
  const getAbstractFileByPath = jest.fn().mockReturnValue(file);
  const app = { vault: { getAbstractFileByPath }, workspace: { getLeaf } } as unknown as App;

  await openComposerPath(app, file.path);
  expect(getAbstractFileByPath).toHaveBeenCalledWith('Notes/A #1.md');
  expect(getLeaf).toHaveBeenCalledWith('tab');
  expect(openFile).toHaveBeenCalledWith(file);

  getLeaf.mockClear();
  openFile.mockClear();
  getAbstractFileByPath.mockReturnValue(null);
  await openComposerPath(app, file.path);
  expect(Notice).toHaveBeenCalledWith('Note not found in this vault: Notes/A #1.md');
  expect(getLeaf).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
});

it.each([null, new TFile()])('reports the folder path when its target is unavailable (%s)', async target => {
  const app = {
    vault: { getAbstractFileByPath: () => target },
  } as unknown as App;

  await openComposerPath(app, 'Journals/Pages/Travel/');

  expect(Notice).toHaveBeenCalledWith('Folder not found in this vault: Journals/Pages/Travel/');
});

it('reports a failed folder reveal without opening a note', async () => {
  const folder = Object.assign(new TFolder(), { path: 'Journals/Pages/Travel' });
  const app = {
    vault: { getAbstractFileByPath: () => folder },
    workspace: {
      getLeavesOfType: () => [{ view: { revealInFolder: () => { throw new Error('Unavailable'); } } }],
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as App;

  await openComposerPath(app, 'Journals/Pages/Travel/');

  expect(Notice).toHaveBeenCalledWith('Could not reveal folder: Journals/Pages/Travel/');
});

it('reports folders and failures to open a note', async () => {
  const openFile = jest.fn().mockRejectedValue(new Error('View unavailable'));
  const getAbstractFileByPath = jest.fn().mockReturnValue(new TFolder());
  const app = {
    vault: { getAbstractFileByPath }, workspace: { getLeaf: () => ({ openFile }) },
  } as unknown as App;

  await openComposerPath(app, 'Notes');
  expect(Notice).toHaveBeenCalledWith('Note not found in this vault: Notes');
  expect(openFile).not.toHaveBeenCalled();
  getAbstractFileByPath.mockReturnValue(new TFile());
  await openComposerPath(app, 'Notes/A.md');
  expect(Notice).toHaveBeenCalledWith('Could not open note: Notes/A.md');
});
