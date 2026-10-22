import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  type ExecutionArtifactName,
  type ExecutionEvent,
  executionArtifactNameSchema,
  executionEventSchema,
} from '@deepauto/contracts';
import { z } from 'zod';

export {
  ExecutorStartError,
  type GitHubActionsExecutionRequest,
  type GitHubActionsExecutionResult,
  GitHubActionsExecutor,
  type GitHubActionsExecutorConfig,
  isRetryableExecutorStartError,
} from './github-actions-executor';

const harnessRequestSchema = z.object({
  jobId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  workspaceDir: z.string().trim().min(1),
  command: z.array(z.string().trim().min(1)).min(1),
  timeoutMilliseconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000),
  credentialClaimId: z.string().trim().min(1).optional(),
  requiredArtifacts: z.array(executionArtifactNameSchema).default([]),
});

export type CliHarnessRequest = z.input<typeof harnessRequestSchema>;

export type CliHarnessResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  events: ExecutionEvent[];
  artifacts: Partial<Record<ExecutionArtifactName, string>>;
  reason?: string;
};

export type CliHarnessOptions = {
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  baseEnvironment?: NodeJS.ProcessEnv;
};

const inheritedEnvironmentKeys = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'];

export function buildCliEnvironment(
  credentialClaimId?: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    inheritedEnvironmentKeys.flatMap((key) =>
      baseEnvironment[key] ? [[key, baseEnvironment[key]]] : [],
    ),
  );

  if (credentialClaimId) {
    environment.DEEPAUTO_CREDENTIAL_CLAIM_ID = credentialClaimId;
  }

  return environment;
}

function protocolFailure(message: string): Error {
  return new Error(`CLI harness protocol violation: ${message}`);
}

export async function runCliHarness(
  request: CliHarnessRequest,
  options: CliHarnessOptions = {},
): Promise<CliHarnessResult> {
  const parsed = harnessRequestSchema.parse(request);
  if (!isAbsolute(parsed.workspaceDir) || !existsSync(parsed.workspaceDir)) {
    throw new Error(
      'CLI harness requires an existing absolute workspace directory',
    );
  }

  const [executable, ...argumentsList] = parsed.command;
  if (!executable) throw new Error('CLI harness command is required');

  const events: ExecutionEvent[] = [];
  const artifacts: Partial<Record<ExecutionArtifactName, string>> = {};
  let terminalEvent: ExecutionEvent | undefined;
  let protocolError: Error | undefined;
  let timedOut = false;
  let cancelled = false;
  let stdoutBuffer = '';
  const child = spawn(executable, argumentsList, {
    cwd: parsed.workspaceDir,
    env: buildCliEnvironment(parsed.credentialClaimId, options.baseEnvironment),
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const terminate = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, parsed.timeoutMilliseconds);
  const abort = () => {
    cancelled = true;
    terminate();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  const consumeLine = (line: string) => {
    if (!line.trim() || protocolError) return;
    let event: ExecutionEvent;
    try {
      event = executionEventSchema.parse(JSON.parse(line));
    } catch {
      protocolError = protocolFailure(
        'stdout must contain valid JSONL execution events',
      );
      terminate();
      return;
    }

    if (event.attemptId !== parsed.attemptId) {
      protocolError = protocolFailure(
        'event attemptId does not match the harness request',
      );
      terminate();
      return;
    }
    if (terminalEvent) {
      protocolError = protocolFailure('events cannot follow a terminal event');
      terminate();
      return;
    }
    if (events.length === 0 && event.type !== 'started') {
      protocolError = protocolFailure('the first event must be started');
      terminate();
      return;
    }

    events.push(event);
    if (event.type === 'artifact') artifacts[event.name] = event.value;
    if (event.type === 'completed' || event.type === 'failed') {
      terminalEvent = event;
    }
    options.onEvent?.(event);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
  });

  const exit = await new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
    },
  );
  clearTimeout(timeout);
  options.signal?.removeEventListener('abort', abort);
  if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);

  if (protocolError) {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: protocolError.message,
    };
  }
  if (cancelled) return { status: 'cancelled', events, artifacts };
  if (timedOut) return { status: 'timed_out', events, artifacts };
  if (exit.error) {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: 'CLI process failed to start',
    };
  }
  if (exit.code !== 0) {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: `CLI process exited with code ${exit.code ?? 'unknown'}`,
    };
  }
  if (terminalEvent?.type === 'failed') {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: terminalEvent.reason,
    };
  }
  if (terminalEvent?.type !== 'completed') {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: 'CLI process exited without a terminal event',
    };
  }

  const missingArtifact = parsed.requiredArtifacts.find(
    (artifact) => !artifacts[artifact],
  );
  if (missingArtifact) {
    return {
      status: 'failed',
      events,
      artifacts,
      reason: `CLI process completed without required artifact: ${missingArtifact}`,
    };
  }
  return { status: 'completed', events, artifacts };
}
