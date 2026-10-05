import { ComposerSelections, type ComposerSelectionSources } from '@/features/chat/input/ComposerSelections';

const SELECTION_POLL_INTERVAL = 250;

function createSources() {
  return {
    editor: { start: jest.fn(), stop: jest.fn(), poll: jest.fn(), getContext: jest.fn(() => null) },
    browser: { poll: jest.fn(async () => undefined), clear: jest.fn(), getContext: jest.fn(() => null) },
    canvas: { poll: jest.fn(), clear: jest.fn(), getContext: jest.fn(() => null) },
  } satisfies ComposerSelectionSources;
}

describe('ComposerSelections polling', () => {
  let selections: ComposerSelections | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    selections?.stop();
    selections = null;
    jest.useRealTimers();
  });

  it('polls every source on the shared cadence', () => {
    const sources = createSources();
    selections = new ComposerSelections(sources);
    selections.start();

    jest.advanceTimersByTime(SELECTION_POLL_INTERVAL - 1);
    expect(sources.editor.poll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(sources.editor.poll).toHaveBeenCalledTimes(1);
    expect(sources.browser.poll).toHaveBeenCalledTimes(1);
    expect(sources.canvas.poll).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(SELECTION_POLL_INTERVAL);
    expect(sources.canvas.poll).toHaveBeenCalledTimes(2);
  });

  it('starts one timer however often it is started', () => {
    const sources = createSources();
    selections = new ComposerSelections(sources);
    selections.start();
    selections.start();

    expect(sources.editor.start).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SELECTION_POLL_INTERVAL);
    expect(sources.canvas.poll).toHaveBeenCalledTimes(1);
  });

  it('stops polling and drops every selection', () => {
    const sources = createSources();
    selections = new ComposerSelections(sources);
    selections.start();
    selections.stop();

    expect(sources.editor.stop).toHaveBeenCalledTimes(1);
    expect(sources.browser.clear).toHaveBeenCalledTimes(1);
    expect(sources.canvas.clear).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SELECTION_POLL_INTERVAL * 4);
    expect(sources.editor.poll).not.toHaveBeenCalled();
    expect(sources.browser.poll).not.toHaveBeenCalled();
    expect(sources.canvas.poll).not.toHaveBeenCalled();
  });

  it('restarts polling after a stop', () => {
    const sources = createSources();
    selections = new ComposerSelections(sources);
    selections.start();
    selections.stop();
    selections.start();

    jest.advanceTimersByTime(SELECTION_POLL_INTERVAL);
    expect(sources.canvas.poll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['editor', (sources: ReturnType<typeof createSources>) => sources.editor.poll.mockImplementation(() => { throw new Error('editor failed'); })],
    ['browser', (sources: ReturnType<typeof createSources>) => sources.browser.poll.mockImplementation(() => { throw new Error('browser failed'); })],
    ['browser (async)', (sources: ReturnType<typeof createSources>) => sources.browser.poll.mockImplementation(async () => { throw new Error('browser failed'); })],
    ['canvas', (sources: ReturnType<typeof createSources>) => sources.canvas.poll.mockImplementation(() => { throw new Error('canvas failed'); })],
  ])('keeps polling the other sources when the %s poll fails', async (_name, fail) => {
    const sources = createSources();
    fail(sources);
    selections = new ComposerSelections(sources);
    selections.start();

    expect(() => jest.advanceTimersByTime(SELECTION_POLL_INTERVAL * 2)).not.toThrow();
    await Promise.resolve();

    expect(sources.editor.poll).toHaveBeenCalledTimes(2);
    expect(sources.browser.poll).toHaveBeenCalledTimes(2);
    expect(sources.canvas.poll).toHaveBeenCalledTimes(2);
  });
});
