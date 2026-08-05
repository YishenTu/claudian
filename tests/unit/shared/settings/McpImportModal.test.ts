import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { McpImportModal } from '@/shared/settings/McpImportModal';

describe('McpImportModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the modal open when the pasted configuration is rejected', async () => {
    const onImport = jest.fn().mockResolvedValue(false);
    const modal = new McpImportModal({} as App, onImport);
    const testModal = modal as unknown as {
      pastedConfig: string;
      submit(): Promise<void>;
    };
    testModal.pastedConfig = '{ invalid json';

    await testModal.submit();

    expect(onImport).toHaveBeenCalledWith('{ invalid json');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('closes after a pasted configuration is accepted', async () => {
    const onImport = jest.fn().mockResolvedValue(true);
    const modal = new McpImportModal({} as App, onImport);
    const testModal = modal as unknown as {
      pastedConfig: string;
      submit(): Promise<void>;
    };
    testModal.pastedConfig = '{"server":{"command":"node"}}';

    await testModal.submit();

    expect(onImport).toHaveBeenCalledWith('{"server":{"command":"node"}}');
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('requires explicit pasted text before importing', async () => {
    const onImport = jest.fn();
    const modal = new McpImportModal({} as App, onImport);

    await (modal as unknown as { submit(): Promise<void> }).submit();

    expect(onImport).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('Paste an mcp configuration first');
  });
});
