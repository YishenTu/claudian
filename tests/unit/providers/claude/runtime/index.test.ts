import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';
import { QueryOptionsBuilder } from '@/providers/claude/runtime/ClaudeQueryOptionsBuilder';
import { SessionManager } from '@/providers/claude/runtime/ClaudeSessionManager';

describe('core/agent index', () => {
  it('imports resolve to the provider-owned runtime symbols', () => {
    expect(ClaudianService).toBeDefined();
    expect(MessageChannel).toBeDefined();
    expect(QueryOptionsBuilder).toBeDefined();
    expect(SessionManager).toBeDefined();
  });
});
