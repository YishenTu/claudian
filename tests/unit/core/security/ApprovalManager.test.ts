
import { ApprovalManager } from '../../../../src/core/security/ApprovalManager';
import type { CCPermissions} from '../../../../src/core/types';
import { createPermissionRule } from '../../../../src/core/types';

describe('ApprovalManager', () => {
    let manager: ApprovalManager;
    let mockPermissions: CCPermissions = {
        allow: [],
        deny: [],
        ask: []
    };

    beforeEach(() => {
        mockPermissions = { allow: [], deny: [], ask: [] };
        // Factory returns reference to our mock
        manager = new ApprovalManager(() => mockPermissions);
    });

    describe('priority order', () => {
        // Priority: session-deny > persistent-deny > session-allow > persistent-allow > persistent-ask

        it('should prefer session deny over all else', async () => {
            // allow always
            const pattern = JSON.stringify({ arg: 'val' });
            mockPermissions.allow = [createPermissionRule(`tool(${pattern})`)];
            // session deny
            await manager.denyAction('tool', { arg: 'val' }, 'session');

            expect(manager.checkPermission('tool', { arg: 'val' })).toBe('deny');
        });

        it('should prefer persistent deny over session allow', async () => {
            // deny always - use correct format tool(pattern)
            const pattern = JSON.stringify({ arg: 'val' });
            mockPermissions.deny = [createPermissionRule(`tool(${pattern})`)];
            // session allow
            await manager.approveAction('tool', { arg: 'val' }, 'session');

            expect(manager.checkPermission('tool', { arg: 'val' })).toBe('deny');
        });
    });

    describe('denyAction', () => {
        it('should add to session deny list', async () => {
            await manager.denyAction('tool', { arg: 'val' }, 'session');
            expect(manager.checkPermission('tool', { arg: 'val' })).toBe('deny');
        });

        it('should trigger callback for always deny', async () => {
            const callback = jest.fn();
            manager.setAddDenyRuleCallback(callback);

            await manager.denyAction('tool', { arg: 'val' }, 'always');

            expect(callback).toHaveBeenCalledWith(expect.stringContaining('tool'));
        });
    });
});
