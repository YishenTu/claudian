import { EventEmitter } from 'node:events';

interface Service {
  readonly name: string;
  readonly port: number;
  readonly protocol: string;
  readonly type: string;
  readonly txt: Readonly<Record<string, string>>;
}

const services = new Set<Service>();
const browsers = new Set<() => void>();

// Deliver published DNS-SD records between the two real discovery implementations.
// Hosted runners do not reliably route multicast packets back to local browsers.
export class BonjourFixture {
  readonly server = { mdns: new EventEmitter() };
  private readonly stops = new Set<() => void>();

  publish(input: Service): { stop(callback?: () => void): void } {
    const service = structuredClone(input);
    services.add(service);
    for (const update of browsers) queueMicrotask(update);
    const stop = (): void => { services.delete(service); this.stops.delete(stop); };
    this.stops.add(stop);
    return { stop: callback => { stop(); callback?.(); } };
  }

  find(query: Pick<Service, 'type' | 'protocol'>, onService: (service: Service) => void): {
    stop(): void;
    update(): void;
  } {
    let active = true;
    const update = (): void => {
      if (!active) return;
      for (const service of services) {
        if (service.type === query.type && service.protocol === query.protocol) {
          onService(structuredClone(service));
        }
      }
    };
    const stop = (): void => {
      active = false;
      browsers.delete(update);
      this.stops.delete(stop);
    };
    browsers.add(update);
    this.stops.add(stop);
    queueMicrotask(update);
    return { stop, update };
  }

  destroy(callback?: () => void): void {
    for (const stop of this.stops) stop();
    callback?.();
  }
}
