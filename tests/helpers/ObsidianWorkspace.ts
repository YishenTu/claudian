import { Events } from '@test/helpers/ObsidianEvents';

/** Workspace DOM and events only; fixtures supply the layout APIs they exercise. */
export function createObsidianWorkspace(containerEl?: HTMLElement) {
  const events = new Events();
  return {
    containerEl,
    on: vi.fn(events.on.bind(events)),
    off: vi.fn(events.off.bind(events)),
    offref: vi.fn(events.offref.bind(events)),
    trigger: events.trigger.bind(events),
    listenerCount: events.listenerCount.bind(events),
  };
}
