import type { ProviderInteractionPort } from '@/core/execution';
import {
  AcpInteractionController,
  type AcpRequestPermissionRequest,
} from '@/providers/acp';

const PERMISSION_REQUEST: AcpRequestPermissionRequest = {
  options: [
    { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
    { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
  ],
  sessionId: 'native-session-1',
  toolCall: {
    rawInput: { path: 'README.md' },
    title: 'Read file',
    toolCallId: 'tool-1',
  },
};

function createPort(): jest.Mocked<ProviderInteractionPort> {
  return {
    askUserQuestion: jest.fn(),
    dismissInteraction: jest.fn(),
    requestApproval: jest.fn(),
    requestPlanDecision: jest.fn(),
  };
}

describe('AcpInteractionController', () => {
  it('routes ACP permissions with stable local identity and validates the echoed response', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation(async (request) => ({
      decision: 'allow',
      interactionId: request.interactionId,
    }));
    const controller = new AcpInteractionController({
      getTurnId: () => 'turn-1',
      interactionPort: port,
      sessionInstanceId: 'session-instance-1',
    });

    await expect(controller.requestPermission(PERMISSION_REQUEST)).resolves.toEqual({
      outcome: { optionId: 'allow-once', outcome: 'selected' },
    });

    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionOptions: [
          { decision: 'allow', label: 'Allow once', value: 'allow-once' },
          { label: 'Reject', value: 'reject' },
        ],
        input: { path: 'README.md' },
        interactionId: 'session-instance-1:approval:1',
        kind: 'approval',
        nativeContext: {
          sessionId: 'native-session-1',
          toolCallId: 'tool-1',
        },
        sessionInstanceId: 'session-instance-1',
        toolName: 'Read file',
        turnId: 'turn-1',
      }),
      expect.any(AbortSignal),
    );
    expect(port.dismissInteraction).toHaveBeenCalledWith(
      'session-instance-1:approval:1',
      'resolved',
    );
  });

  it('allows a provider-owned permission presentation without changing ACP decisions', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation(async (request) => ({
      decision: 'allow',
      interactionId: request.interactionId,
    }));
    const controller = new AcpInteractionController({
      getTurnId: () => 'turn-1',
      interactionPort: port,
      presentPermission: (_request, input) => ({
        blockedPath: String(input.path),
        decisionReason: 'Path is outside the session working directory',
        description: 'Provider wants to access an external path.',
        toolName: 'External Directory',
      }),
      sessionInstanceId: 'session-instance-1',
    });

    await controller.requestPermission(PERMISSION_REQUEST);

    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedPath: 'README.md',
        decisionReason: 'Path is outside the session working directory',
        description: 'Provider wants to access an external path.',
        input: { path: 'README.md' },
        toolName: 'External Directory',
      }),
      expect.any(AbortSignal),
    );
  });

  it('cancels stale or cross-turn resolutions instead of applying them', async () => {
    let turnId = 'turn-1';
    let resolveApproval!: (value: {
      decision: 'allow';
      interactionId: string;
    }) => void;
    const port = createPort();
    port.requestApproval.mockImplementation((request) => new Promise((resolve) => {
      resolveApproval = resolve;
      expect(request.turnId).toBe('turn-1');
    }));
    const controller = new AcpInteractionController({
      getTurnId: () => turnId,
      interactionPort: port,
      sessionInstanceId: 'session-instance-1',
    });

    const pending = controller.requestPermission(PERMISSION_REQUEST);
    await Promise.resolve();
    turnId = 'turn-2';
    resolveApproval({
      decision: 'allow',
      interactionId: 'session-instance-1:approval:1',
    });

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(port.dismissInteraction).toHaveBeenLastCalledWith(
      'session-instance-1:approval:1',
      'superseded',
    );
  });

  it('aborts and dismisses pending interactions on disposal', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    }));
    const controller = new AcpInteractionController({
      getTurnId: () => 'turn-1',
      interactionPort: port,
      sessionInstanceId: 'session-instance-1',
    });

    const pending = controller.requestPermission(PERMISSION_REQUEST);
    await Promise.resolve();
    controller.dispose();
    controller.dispose();

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(port.dismissInteraction).toHaveBeenCalledTimes(1);
    expect(port.dismissInteraction).toHaveBeenCalledWith(
      'session-instance-1:approval:1',
      'session-disposed',
    );
    await expect(controller.requestPermission(PERMISSION_REQUEST)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
