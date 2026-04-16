import type { StreamChunk, UsageInfo } from '../../../core/types';
import type {
  AcpMessageStopParams,
  AcpTextDeltaParams,
  AcpToolResultParams,
  AcpToolUseStartParams,
} from '../protocol/acpProtocolTypes';

type ChunkEmitter = (chunk: StreamChunk) => void;

/**
 * Maps ACP notifications to StreamChunk types.
 * Adapted from CodexNotificationRouter for the ACP protocol.
 */
export class AcpNotificationRouter {
  constructor(private readonly emit: ChunkEmitter) {}

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'chat/textDelta':
        this.onTextDelta(params as AcpTextDeltaParams);
        break;
      case 'chat/toolUseStart':
        this.onToolUseStart(params as AcpToolUseStartParams);
        break;
      case 'chat/toolResult':
        this.onToolResult(params as AcpToolResultParams);
        break;
      case 'chat/messageStop':
        this.onMessageStop(params as AcpMessageStopParams);
        break;
      case 'chat/error':
        this.onError(params as { error: string });
        break;
      default:
        // Unknown notification - ignore
        break;
    }
  }

  private onTextDelta(params: AcpTextDeltaParams): void {
    this.emit({ type: 'text', content: params.delta });
  }

  private onToolUseStart(params: AcpToolUseStartParams): void {
    this.emit({
      type: 'tool_use',
      id: params.toolUseId,
      name: params.name,
      input: params.input,
    });
  }

  private onToolResult(params: AcpToolResultParams): void {
    this.emit({
      type: 'tool_result',
      id: params.toolUseId,
      content: params.content ?? '',
      isError: params.isError ?? false,
    });
  }

  private onMessageStop(_params: AcpMessageStopParams): void {
    this.emit({ type: 'done' });
  }

  private onError(params: { error: string }): void {
    this.emit({ type: 'error', content: params.error });
  }
}
