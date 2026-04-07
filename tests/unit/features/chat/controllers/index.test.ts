import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { InputController } from '@/features/chat/controllers/InputController';
import { NavigationController } from '@/features/chat/controllers/NavigationController';
import { SelectionController } from '@/features/chat/controllers/SelectionController';
import { StreamController } from '@/features/chat/controllers/StreamController';

describe('features/chat/controllers index', () => {
  it('re-exports runtime symbols', () => {
    expect(ConversationController).toBeDefined();
    expect(InputController).toBeDefined();
    expect(NavigationController).toBeDefined();
    expect(SelectionController).toBeDefined();
    expect(StreamController).toBeDefined();
  });
});

