/** @vitest-environment jsdom */
import { triggerResize } from '@test/helpers/dom/ResizeObserver';

it('delivers explicit resize entries only to observers still watching the target', () => {
  const target = document.createElement('div');
  const other = document.createElement('div');
  const changed = vi.fn();
  const unrelated = vi.fn();
  const observer = new ResizeObserver(changed);
  const otherObserver = new ResizeObserver(unrelated);
  observer.observe(target);
  otherObserver.observe(other);
  expect(changed).not.toHaveBeenCalled();
  const entry = {
    contentRect: new DOMRect(0, 0, 200, 100),
    borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
  };
  triggerResize(target, entry);
  expect(changed.mock.calls).toEqual([[[{ ...entry, target }], observer]]);
  expect(unrelated).not.toHaveBeenCalled();
  observer.unobserve(target);
  triggerResize(target, entry);
  expect(changed).toHaveBeenCalledTimes(1);
  observer.observe(target);
  observer.disconnect();
  triggerResize(target, entry);
  expect(changed).toHaveBeenCalledTimes(1);
  otherObserver.disconnect();
});
