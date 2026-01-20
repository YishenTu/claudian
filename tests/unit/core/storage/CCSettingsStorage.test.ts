
import { CC_SETTINGS_PATH,CCSettingsStorage } from '../../../../src/core/storage/CCSettingsStorage';
import type { VaultFileAdapter } from '../../../../src/core/storage/VaultFileAdapter';
import { createPermissionRule } from '../../../../src/core/types';

// Mock VaultFileAdapter
const mockAdapter = {
    exists: jest.fn(),
    read: jest.fn(),
    write: jest.fn(),
} as unknown as VaultFileAdapter;

describe('CCSettingsStorage', () => {
    let storage: CCSettingsStorage;

    beforeEach(() => {
        jest.clearAllMocks();
        storage = new CCSettingsStorage(mockAdapter);
    });

    describe('load', () => {
        it('should return defaults if file does not exist', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(false);
            const result = await storage.load();
            expect(result.permissions).toBeDefined();
        });

        it('should load and parse allowed permissions', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: ['tool1'],
                    deny: [],
                    ask: []
                }
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toContain('tool1');
        });

        it('should throw on read error', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockRejectedValue(new Error('Read failed'));

            await expect(storage.load()).rejects.toThrow('Read failed');
        });
    });

    describe('addAllowRule', () => {
        it('should add rule to allow list and save', async () => {
            // Setup initial state
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] }
            }));

            await storage.addAllowRule(createPermissionRule('new-rule'));

            const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions.allow).toContain('new-rule');
        });

        it('should not duplicate existing rule', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: ['existing'], deny: [], ask: [] }
            }));

            await storage.addAllowRule(createPermissionRule('existing'));

            expect(mockAdapter.write).not.toHaveBeenCalled();
        });
    });

    describe('removeRule', () => {
        it('should remove rule from all lists', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: ['rule1'],
                    deny: ['rule1'],
                    ask: ['rule1']
                }
            }));

            await storage.removeRule(createPermissionRule('rule1'));

            expect(mockAdapter.write).toHaveBeenCalledWith(
                CC_SETTINGS_PATH,
                expect.stringContaining('"allow": []')
            );
        });
    });

    describe('enabledPlugins', () => {
        it('should return empty object if enabledPlugins not set', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] }
            }));

            const result = await storage.getEnabledPlugins();
            expect(result).toEqual({});
        });

        it('should return enabledPlugins from settings', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] },
                enabledPlugins: { 'plugin-a': true, 'plugin-b': false }
            }));

            const result = await storage.getEnabledPlugins();
            expect(result).toEqual({ 'plugin-a': true, 'plugin-b': false });
        });

        it('should set plugin enabled state and persist', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] },
                enabledPlugins: { 'existing-plugin': true }
            }));

            await storage.setPluginEnabled('new-plugin@source', false);

            const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.enabledPlugins).toEqual({
                'existing-plugin': true,
                'new-plugin@source': false
            });
        });

        it('should update existing plugin state', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] },
                enabledPlugins: { 'plugin-a': true }
            }));

            await storage.setPluginEnabled('plugin-a', false);

            const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.enabledPlugins['plugin-a']).toBe(false);
        });

        it('should preserve enabledPlugins when saving other settings', async () => {
            (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
            (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
                permissions: { allow: ['rule1'], deny: [], ask: [] },
                enabledPlugins: { 'plugin-a': false }
            }));

            // Add a permission rule (different operation)
            await storage.addAllowRule(createPermissionRule('new-rule'));

            const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            // enabledPlugins should be preserved from existing file
            expect(writtenContent.enabledPlugins).toEqual({ 'plugin-a': false });
        });
    });
});
