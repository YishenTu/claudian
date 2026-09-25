import '@/providers';

import { Text } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';

import { buildInlineEditInputDecorations } from '@/features/inline-edit/ui/InlineEditModal';

class TestWidget extends WidgetType {
  toDOM(): HTMLElement {
    return {} as HTMLElement;
  }
}

describe('InlineEditModal', () => {
  it('builds line-start block widget decorations without range ordering errors', () => {
    expect(() => buildInlineEditInputDecorations({
      doc: Text.of(['First line', 'Second line']),
      inputPos: 0,
      widget: new TestWidget(),
      isInbetween: false,
    })).not.toThrow();
  });
});
