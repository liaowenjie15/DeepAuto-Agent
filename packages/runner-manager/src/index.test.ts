import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliEnvironment, runCliHarness } from './index';

const fixturePath = fileURLToPath(
  new URL('./fake-cli.test-fixture.ts', import.meta.url),
);
const workspaceDir = mkdtempSync(join(tmpdir(), 'deepauto-harness-'));

function request(scenario: string, overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    attemptId: 'attempt-1',
    workspaceDir,
    command: ['/usr/bin/env', 'bun', fixturePath, scenario, 'attempt-1'],
    timeoutMilliseconds: 1_000,
    ...overrides,
  };
}

test('runs a task-bound JSONL CLI in the requested workspace', async () => {
  const result = await runCliHarness(
    request('workspace', { requiredArtifacts: ['workspace'] }),
  );

  expect(result.status).toBe('completed');
  expect(result.artifacts.workspace).toBe(realpathSync(workspaceDir));
  expect(result.events.map((event) => event.type)).toEqual([
    'started',
    'artifact',
    'completed',
  ]);
});

test('does not pass long-lived credentials or database access to the CLI', () => {
  expect(
    buildCliEnvironment('claim-1', {
      PATH: '/bin',
      DATABASE_URL: 'postgresql://secret',
      GITHUB_TOKEN: 'secret',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    }),
  ).toEqual({ PATH: '/bin', DEEPAUTO_CREDENTIAL_CLAIM_ID: 'claim-1' });
});

test('turns a non-zero CLI exit into a failed execution result', async () => {
  const result = await runCliHarness(request('failed'));

  expect(result.status).toBe('failed');
  expect(result.reason).toBe('CLI process exited with code 1');
});

test('rejects missing terminal events and task identity violations', async () => {
  expect((await runCliHarness(request('no-terminal'))).status).toBe('failed');
  const wrongAttempt = await runCliHarness(request('wrong-attempt'));
  expect(wrongAttempt.status).toBe('failed');
  expect(wrongAttempt.reason).toContain('attemptId');
});

test('rejects repeated terminal events', async () => {
  const result = await runCliHarness(request('duplicate-terminal'));

  expect(result.status).toBe('failed');
  expect(result.reason).toContain('terminal event');
});

test('supports explicit cancellation and deadline expiry', async () => {
  const controller = new AbortController();
  const cancelled = await runCliHarness(request('hang'), {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'started') controller.abort();
    },
  });
  const timedOut = await runCliHarness(
    request('hang', { timeoutMilliseconds: 30 }),
  );

  expect(cancelled.status).toBe('cancelled');
  expect(timedOut.status).toBe('timed_out');
});

test('fails a completed CLI that omits required artifacts', async () => {
  const result = await runCliHarness(
    request('completed', { requiredArtifacts: ['commit_sha'] }),
  );

  expect(result.status).toBe('failed');
  expect(result.reason).toContain('commit_sha');
});
