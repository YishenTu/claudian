
import { ClaudianService } from '../../../../src/core/agent/ClaudianService';
import type { McpServerManager } from '../../../../src/core/mcp';
import type { ApprovalManager } from '../../../../src/core/security';
import { createPermissionRule, type PermissionRule } from '../../../../src/core/types';
import type ClaudianPlugin from '../../../../src/main';

// Mock dependencies
const mockPlugin = {
    storage: {
        addDenyRule: jest.fn(),
        getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    },
} as unknown as ClaudianPlugin;

const mockMcpManager = {} as unknown as McpServerManager;

describe('ClaudianService', () => {
    let service: ClaudianService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new ClaudianService(mockPlugin, mockMcpManager);
    });

    describe('deny-always flow', () => {
        it('should persist deny rule when deny-always is selected', async () => {
            // Setup ApprovalManager mock behavior if accessible, or trigger the flow
            // Since ApprovalManager is private, we might need to test via public API or spy on internals
            // For this test, we assume we can trigger handleToolUse or similar that eventually calls the callback

            // Direct test of the callback registered in constructor:
            // accessing private property for testing if necessary, or refactoring for testability.
            // Given Jest, we can often access private members with casting.

            const approvalManager = (service as any).approvalManager as ApprovalManager;

            // Simulate "deny-always" outcome
            // The callback setAddDenyRuleCallback is what we want to verify triggers storage

            const rule = 'test-tool::{"arg":"val"}';

            // Manually trigger the callback logic that ApprovalManager would invoke
            // This requires knowing how ApprovalManager invokes it.
            // Based on constructor:
            /*
              this.approvalManager.setAddDenyRuleCallback(async (rule) => {
                try {
                  await this.plugin.storage.addDenyRule(rule);
                  await this.loadCCPermissions();
                } ...
              });
            */

            // We can verify this by checking if plugin.storage.addDenyRule is called 
            // when we invoke the private callback.

            // However, a better integration test would use the ApprovalManager's checkPermission method
            // if we can mock the user response to be 'deny-always'.

            // Let's rely on the public API for the callback property if it exists, or just verify the behavior 
            // of the callback itself if exposed.

            // Assuming we can't easily trigger the full flow without complex setup, 
            // let's test the callback registration logic by inspecting what was registered
            // OR better, instantiate ApprovalManager with a spy?

            // Actually, since we want to test ClaudianService's handling of specific logic:

            // Let's try to simulate the flow via `handleToolUse` if possible, or just the callback logic.

            // Access the callback registered in the constructor
            // Access the callback registered in the constructor
            const callback = (approvalManager as any).addDenyRuleCallback;
            // Cast to function to satisfy TS and avoid 'if'
            await (callback as (rule: PermissionRule) => Promise<void>)(createPermissionRule(rule));

            // eslint-disable-next-line jest/no-conditional-expect
            expect(mockPlugin.storage.addDenyRule).toHaveBeenCalledWith(rule);
            // eslint-disable-next-line jest/no-conditional-expect
            expect(mockPlugin.storage.getPermissions).toHaveBeenCalled();
        });
    });
});
