import { OrchestratorService } from '@/features/chat/services/OrchestratorService';

function makeService() {
  const sent: Array<{ tabId: string; message: string }> = [];
  const service = new OrchestratorService({
    sendToTab: (tabId, message) => sent.push({ tabId, message }),
  });
  return { service, sent };
}

describe('OrchestratorService', () => {
  describe('registerWorker / getOrchestratorTabId', () => {
    it('returns null for unknown tab', () => {
      const { service } = makeService();
      expect(service.getOrchestratorTabId('unknown')).toBeNull();
    });

    it('returns orchestrator tab id after registration', () => {
      const { service } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      expect(service.getOrchestratorTabId('worker-1')).toBe('orch-1');
    });
  });

  describe('reportResult', () => {
    it('sends result message to orchestrator', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'Found 3 notes.');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: "Worker 'Research' finished: Found 3 notes.",
      });
    });

    it('sends error message when isError is true', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'Something went wrong.', true);
      expect(sent[0].message).toBe("Worker 'Research' failed: Something went wrong.");
    });

    it('sends synthesis trigger when all workers done', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.registerWorker('orch-1', 'worker-2', 'Write');
      service.reportResult('worker-1', 'result-1');
      expect(sent).not.toContainEqual(expect.objectContaining({ message: 'All workers have reported. Please synthesize.' }));
      service.reportResult('worker-2', 'result-2');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: 'All workers have reported. Please synthesize.',
      });
    });

    it('is a no-op for unknown worker', () => {
      const { service, sent } = makeService();
      service.reportResult('ghost', 'result');
      expect(sent).toHaveLength(0);
    });

    it('is a no-op if called twice for the same worker', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'first');
      const countAfterFirst = sent.length;
      service.reportResult('worker-1', 'second');
      expect(sent).toHaveLength(countAfterFirst);
    });

    it('cleans up fleet state after all workers done', () => {
      const { service } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'result');
      // After completion, getOrchestratorTabId should return null (cleaned up)
      expect(service.getOrchestratorTabId('worker-1')).toBeNull();
    });
  });

  describe('handleTabClosed', () => {
    it('counts closed worker as done and notifies orchestrator', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('worker-1');
      expect(sent[0].message).toContain("closed before completing");
    });

    it('fires synthesis trigger if closed worker was the last', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('worker-1');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: 'All workers have reported. Please synthesize.',
      });
    });

    it('is a no-op for orchestrator tab that is closed', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('orch-1');
      // Workers' subsequent reportResult should not crash and should be no-op
      service.reportResult('worker-1', 'late result');
      expect(sent).toHaveLength(0);
    });
  });
});
