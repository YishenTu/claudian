import { CloudToLANApprovalWait } from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANApprovalWait';

describe('Cloud-to-LAN shared event observation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('uses events without periodic requests while WS is healthy', async () => {
    let approved = false;
    let continued = false;
    let reads = 0;
    const wait = new CloudToLANApprovalWait(async () => {
      reads++;
      if (!approved) return { kind: 'waiting' };
      continued = true;
      return { kind: 'completed' };
    });
    wait.start('project-1');
    await jest.advanceTimersByTimeAsync(0);
    const initialReads = reads;
    approved = true;
    await jest.advanceTimersByTimeAsync(90_000);
    expect(reads).toBe(initialReads);
    expect(continued).toBe(false);
    wait.notify('project-1');
    await jest.advanceTimersByTimeAsync(0);
    expect(continued).toBe(true);
    await wait.close();
  });
  it('rechecks when another event arrives during an in-flight read', async () => {
    let finish: (() => void) | undefined;
    let approved = false;
    let continued = false;
    const wait = new CloudToLANApprovalWait(async () => {
      if (approved) { continued = true; return { kind: 'completed' }; }
      await new Promise<void>(resolve => { finish = resolve; });
      return { kind: 'waiting' };
    });
    wait.start('project-1');
    await jest.advanceTimersByTimeAsync(0);
    approved = true;
    wait.notify('project-1');
    finish!();
    await jest.advanceTimersByTimeAsync(0);
    expect(continued).toBe(true);
    await wait.close();
  });
  it('retains a newer hint when the in-flight request fails', async () => {
    let reject!: (error: Error) => void;
    const release = jest.fn();
    const observe = jest.fn(() => ({ dispose: release }));
    const check = jest.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ kind: 'completed' });
    const wait = new CloudToLANApprovalWait(check, observe);
    wait.start('project-1');
    await jest.advanceTimersByTimeAsync(0);
    wait.notify('project-1');
    reject(new Error('Connection interrupted'));
    await jest.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await wait.close();
  });
  it('drains outbound work before shutdown finishes', async () => {
    let settled = false;
    const wait = new CloudToLANApprovalWait(async (_projectId, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { settled = true; resolve({ kind: 'cancelled' }); }, { once: true });
    }));
    wait.start('project-1');
    await jest.advanceTimersByTimeAsync(0);
    await wait.close();
    expect(settled).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
