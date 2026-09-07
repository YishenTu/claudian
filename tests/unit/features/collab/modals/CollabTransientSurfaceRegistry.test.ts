import { CollabTransientSurfaceRegistry } from '@/features/collab/modals/CollabTransientSurfaceRegistry';

describe('CollabTransientSurfaceRegistry', () => {
  it('closes every tracked surface and releases normally closed surfaces', () => {
    const registry = new CollabTransientSurfaceRegistry();
    const first = { close: jest.fn(), open: jest.fn() };
    const second = { close: jest.fn(), open: jest.fn() };
    let closeFirst!: () => void;

    registry.open(onClosed => {
      closeFirst = onClosed;
      return first;
    });
    registry.open(() => second);
    closeFirst();
    registry.closeAll();

    expect(first.open).toHaveBeenCalledTimes(1);
    expect(second.open).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledTimes(1);
    registry.closeAll();
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
