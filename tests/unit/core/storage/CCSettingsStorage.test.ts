
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
});
