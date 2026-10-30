import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import { type ProviderExecutionRequest } from '@/core/execution';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type * as ProcessProbe from '@/core/process/ProcessProbe';
import type { AskUserAnswers } from '@/core/types';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { isRecord, OpencodeHTTPClient } from '@/providers/opencode/http/OpencodeHTTPClient';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

// Real CLI probing, server startup and cleanup can exceed the default test timeout on Windows runners.
vi.setConfig({ testTimeout: 45_000 });

// A cold first turn includes the version probe and the HTTP server's 10-second readiness budget.
const NATIVE_STARTUP_TIMEOUT_MS = 40_000;

// Keep the native probe real, with the same cold-launch allowance as OpencodeSharedServer.
// Explicit probe deadlines still apply; this suite does not test the production default deadline.
vi.mock('@/core/process/ProcessProbe', async () => {
  const actual: typeof ProcessProbe = (await vi.importActual<typeof import('@/core/process/ProcessProbe')>('@/core/process/ProcessProbe'));
  return {
    ...actual,
    runProcessProbe: (options: ManagedStdioProcessOptions, timeoutMs = 30_000) => actual.runProcessProbe(options, timeoutMs),
  };
});

/** Observe real prompt admission without replacing transport or kernel behavior. */
function releaseSteeringEventsOnAdmission(): void {
  const nativeRequest = OpencodeHTTPClient.prototype.request;
  const releases: Promise<void>[] = [];
  const failures: unknown[] = [];
  const observer = vi.spyOn(OpencodeHTTPClient.prototype, 'request').mockImplementation(function<T>(
    this: OpencodeHTTPClient, route: string, options: Parameters<OpencodeHTTPClient['request']>[1],
  ): Promise<T> {
    const admission = nativeRequest.bind(this)<T>(route, options);
    const body = options?.body;
    if (route.endsWith('/prompt') && isRecord(body) && !body.delivery && typeof body.text === 'string' && body.text.startsWith('steer')) {
      // Return the original promise to the kernel. Its synchronous admission continuation
      // runs before this separate HTTP round trip can release any SSE output.
      releases.push(admission.then(() => nativeRequest.call(this, '/fixture/release-prompt-events', {
        method: 'POST', body: { id: body.id },
      })).then(() => undefined, error => { failures.push(error); }));
    }
    return admission;
  });
  onTestFinished(async () => {
    observer.mockRestore();
    await Promise.all(releases);
    expect(failures).toEqual([]);
  });
}

async function createFixture(resume = false, approval?: (signal: AbortSignal) => Promise<void>, environmentVariables = '', resolveAnswers?: (questions: unknown) => AskUserAnswers) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-execution-')));
  const cliPath = path.join(root, 'opencode.cjs');
  writeOpencodeNativePeer(cliPath, { scenario: 'execution', version: '2.0.12' });
  const hostFixture = await createProviderHostFixture({
    settings: { model: 'opencode:deepseek/chat', providerConfigs: { opencode: { enabled: true, visibleModels: ['deepseek/chat'], discoveredModels: [{ rawId: 'deepseek/chat', label: 'DeepSeek' }], environmentVariables: [`XDG_DATA_HOME=${path.join(root, 'data')}`, resume ? 'EXPECT_RESUME=1' : '', environmentVariables].join('\n') } } },
    overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cliPath },
  });
  const plugin = hostFixture.host;
  const approvals: unknown[] = [], questions: unknown[] = [];
  const serverService = new OpencodeServerService();
  const session = new OpencodeExecutionBackend(plugin.getRuntimeHost('opencode'), { serverService }).createSession({
    ...(resume ? { resumeSeed: { providerSessionId: 'ses_test' } } : {}),
    workingDirectory: root, lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
    interactionPort: {
      requestApproval: async (request, signal) => { approvals.push(request); await approval?.(signal); return { interactionId: request.interactionId, decision: 'allow' }; },
      askUserQuestion: async request => { questions.push(request); const questionsInput = request.input.questions; return { interactionId: request.interactionId, answers: resolveAnswers ? resolveAnswers(questionsInput) : { q0: Array.isArray(questionsInput) ? questionsInput[0].options[0].value : '' } }; },
      dismissInteraction() {},
    },
  });
  return { root, plugin, settings: hostFixture.settings, session, approvals, questions, async dispose() { await session.dispose(); await serverService.dispose(); await hostFixture.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

function request(text = '/review changes'): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text }],
    configuration: { model: 'opencode:deepseek/chat', permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Review changes.' } },
    toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
  };
}

const writingSkill = { skills: [{ id: 'writing', mention: { start: 0, end: 8, text: '/writing' } }] };

export { createFixture, NATIVE_STARTUP_TIMEOUT_MS, releaseSteeringEventsOnAdmission, request, writingSkill };
