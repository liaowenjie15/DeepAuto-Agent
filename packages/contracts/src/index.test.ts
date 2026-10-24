import { expect, it } from 'bun:test';
import {
  executionEventSchema,
  executionResultSchema,
  inboundInvocationSchema,
  invocationSchema,
} from './index';

const invocation = {
  source: 'feishu',
  workspaceId: 'workspace-1',
  actorId: 'user-1',
  conversationKey: 'thread-1',
  anchor: 'message',
  instruction: 'Summarize this thread',
  sourceEventId: 'event-1',
  receivedAt: '2026-10-19T00:00:00.000Z',
};

it('accepts a complete invocation', () => {
  expect(invocationSchema.safeParse(invocation).success).toBe(true);
});

it('rejects an unsupported source and missing caller identity', () => {
  expect(
    invocationSchema.safeParse({ ...invocation, source: 'unknown' }).success,
  ).toBe(false);
  expect(
    invocationSchema.safeParse({ ...invocation, actorId: ' ' }).success,
  ).toBe(false);
});

it('requires a stable conversation and event key', () => {
  expect(
    invocationSchema.safeParse({ ...invocation, conversationKey: '' }).success,
  ).toBe(false);
  expect(
    invocationSchema.safeParse({ ...invocation, sourceEventId: '' }).success,
  ).toBe(false);
});

it('requires an external actor and idempotency key before gateway authorization', () => {
  expect(
    inboundInvocationSchema.safeParse({
      ...invocation,
      idempotencyKey: 'feishu:message-1',
      providerActorId: 'ou_actor',
    }).success,
  ).toBe(true);
  expect(
    inboundInvocationSchema.safeParse({
      ...invocation,
      idempotencyKey: ' ',
      providerActorId: 'ou_actor',
    }).success,
  ).toBe(false);
});

it('accepts only structured execution events with task-bound IDs', () => {
  expect(
    executionEventSchema.safeParse({
      type: 'artifact',
      attemptId: 'attempt-1',
      name: 'test_result',
      value: 'bun run test',
    }).success,
  ).toBe(true);
  expect(
    executionEventSchema.safeParse({
      type: 'artifact',
      attemptId: 'attempt-1',
      name: 'prompt_layers',
      value: '{"schemaVersion":1}',
    }).success,
  ).toBe(true);
  expect(
    executionEventSchema.safeParse({ type: 'completed', attemptId: ' ' })
      .success,
  ).toBe(false);
});

it('accepts a safe structured terminal execution result', () => {
  expect(
    executionResultSchema.safeParse({
      status: 'TIMED_OUT',
      failureCategory: 'TIMEOUT',
      safeSummary: 'The execution exceeded its deadline and will retry.',
      retryable: true,
      logReference: {
        provider: 'local_sandbox',
        reference: 'execution-1/attempt-1.log',
        expiresAt: '2026-11-24T00:00:00.000Z',
      },
      testSummary: { total: 3, passed: 2, failed: 1, skipped: 0 },
      artifacts: [{ name: 'test_result', reference: 'artifact://test-1' }],
      finishedAt: '2026-10-25T00:00:00.000Z',
    }).success,
  ).toBe(true);
});

it('rejects unsafe summaries and invalid retry policies', () => {
  expect(
    executionResultSchema.safeParse({
      status: 'FAILED',
      failureCategory: 'VALIDATION_FAILED',
      safeSummary: 'DATABASE_URL=postgresql://user:secret@example.test/db',
      retryable: false,
      artifacts: [],
      finishedAt: '2026-10-25T00:00:00.000Z',
    }).success,
  ).toBe(false);
  expect(
    executionResultSchema.safeParse({
      status: 'FAILED',
      failureCategory: 'VALIDATION_FAILED',
      safeSummary: 'Validation failed.',
      retryable: true,
      artifacts: [],
      finishedAt: '2026-10-25T00:00:00.000Z',
    }).success,
  ).toBe(false);
});
