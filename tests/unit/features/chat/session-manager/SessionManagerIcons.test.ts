import { addIcon } from 'obsidian';

import {
  registerSessionManagerIcons,
  SESSION_COLLAPSE_ALL_ICON,
  SESSION_EXPAND_ALL_ICON,
} from '@/features/chat/session-manager/SessionManagerIcons';

describe('SessionManagerIcons', () => {
  it('registers stable local icons for collapse-all and expand-all', () => {
    registerSessionManagerIcons();
    registerSessionManagerIcons();

    expect(addIcon).toHaveBeenCalledTimes(2);
    expect(addIcon).toHaveBeenCalledWith(
      SESSION_COLLAPSE_ALL_ICON,
      expect.stringContaining('m15 5 3 3 3-3'),
    );
    expect(addIcon).toHaveBeenCalledWith(
      SESSION_EXPAND_ALL_ICON,
      expect.stringContaining('m15 8 3-3 3 3'),
    );
  });
});
