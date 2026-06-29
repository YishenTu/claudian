import type {
	ProviderRuntimeCommandLoader,
	ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import { HermesChatRuntime } from '../runtime/HermesChatRuntime';
import { getHermesProviderSettings } from '../settings';

export class HermesRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
	isAvailable(settings: Record<string, unknown>): boolean {
		return getHermesProviderSettings(settings).enabled;
	}

	async loadCommands(context: ProviderRuntimeCommandLoaderContext) {
		if (!context.runtime && !context.conversation?.sessionId) {
			if (!context.allowSessionCreation) {
				return [];
			}
		}

		const canReuseRuntime = context.runtime?.providerId === 'hermes'
			&& !context.conversation?.sessionId;
		const runtime = canReuseRuntime
			? context.runtime!
			: new HermesChatRuntime(context.plugin);

		try {
			if (context.conversation) {
				runtime.syncConversationState(context.conversation, context.externalContextPaths);
			}

			const ready = await runtime.ensureReady({
				allowSessionCreation: context.allowSessionCreation ?? false,
			});
			if (!ready) {
				return [];
			}

			return await runtime.getSupportedCommands();
		} finally {
			if (runtime !== context.runtime) {
				runtime.cleanup();
			}
		}
	}
}
