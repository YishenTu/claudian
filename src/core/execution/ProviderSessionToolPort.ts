import type {
  SessionToolDestinations,
  SessionToolListDestinationsArgs,
  SessionToolReadSessionArgs,
  SessionToolReadSessionResult,
  SessionToolSendMessageArgs,
  SessionToolSendMessageResult,
} from '../session-tools/sessionToolSpecs';
import type { ProviderToolPolicy } from './ProviderExecutionRequest';

/**
 * Feature-owned session tools, bound to the calling main chat session.
 *
 * The port is opaque: it exposes no conversation identity. Its presence on a
 * session configuration is what makes the session a main chat. Each call takes
 * decoded arguments and the signal of the run that owns the native call. Rejections carry
 * model-facing messages.
 */
export interface ProviderSessionToolPort {
  list(args: SessionToolListDestinationsArgs, signal: AbortSignal): Promise<SessionToolDestinations>;
  send(args: SessionToolSendMessageArgs, signal: AbortSignal): Promise<SessionToolSendMessageResult>;
  read(args: SessionToolReadSessionArgs, signal: AbortSignal): Promise<SessionToolReadSessionResult>;
}

/**
 * Session tools are callable only under the default or unrestricted request
 * policy. An allow-list naming them is still denied, whatever the native
 * approval mode.
 */
export function isSessionToolPolicyAllowed(policy: ProviderToolPolicy | undefined): boolean {
  return policy?.kind === 'provider-default' || policy?.kind === 'unrestricted';
}
