import {
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from '@/features/chat/controllers';

describe('features/chat/controllers index', () => {
  it('re-exports runtime symbols', () => {
    expect(ConversationController).toBeDefined();
    expect(InputController).toBeDefined();
    expect(NavigationController).toBeDefined();
    expect(SelectionController).toBeDefined();
    expect(StreamController).toBeDefined();
  });
});

