import { WorkspaceLeaf } from 'obsidian';

import { ClaudianView } from '../src/ClaudianView';
import type { ChatMessage, ImageAttachment } from '../src/types';

function createMockPlugin() {
  return {
    settings: {
      enableBlocklist: true,
      blockedCommands: { unix: [], windows: [] },
      showToolUse: true,
      model: 'haiku',
      thinkingBudget: 'off',
      permissionMode: 'yolo',
      permissions: [],
      excludedTags: [],
      mediaFolder: '',
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
      workspace: {
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getRightLeaf: jest.fn().mockReturnValue(null),
        revealLeaf: jest.fn(),
        on: jest.fn(),
      },
      metadataCache: {
        on: jest.fn(),
        getFileCache: jest.fn().mockReturnValue(null),
      },
    },
    agentService: {
      query: jest.fn(),
      cancel: jest.fn(),
      resetSession: jest.fn(),
      setApprovalCallback: jest.fn(),
      setSessionId: jest.fn(),
      getSessionId: jest.fn().mockReturnValue(null),
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    createConversation: jest.fn().mockResolvedValue({
      id: 'conv-1',
      title: 'Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: null,
      messages: [],
    }),
    switchConversation: jest.fn().mockResolvedValue(null),
    updateConversation: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as any;
}

describe('ClaudianView persistence', () => {
  it('strips base64 data when persisting messages but keeps references', () => {
    const plugin = createMockPlugin();
    const view = new ClaudianView(new WorkspaceLeaf(), plugin);

    const images: ImageAttachment[] = [
      {
        id: 'img-1',
        name: 'cached.png',
        mediaType: 'image/png',
        size: 10,
        cachePath: '.claudian-cache/images/cached.png',
        filePath: 'images/cached.png',
        data: 'YmFzZTY0',
        source: 'paste',
      },
    ];

    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
        images,
      },
    ];

    (view as any).messages = messages;

    const persisted = (view as any).getPersistedMessages();

    expect(persisted[0].images?.[0].data).toBeUndefined();
    expect(persisted[0].images?.[0].cachePath).toBe('.claudian-cache/images/cached.png');
    expect(persisted[0].images?.[0].filePath).toBe('images/cached.png');
  });
});
