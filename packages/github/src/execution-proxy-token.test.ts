import { expect, test } from 'bun:test';
import {
  issueExecutionProxyToken,
  verifyExecutionProxyToken,
} from './execution-proxy-token';

const secret = 'a-long-test-secret-that-is-at-least-thirty-two-characters';
const now = new Date('2026-10-21T00:00:00.000Z');

test('issues a short-lived token bound to one execution', async () => {
  const token = await issueExecutionProxyToken({
    executionId: 'execution-1',
    secret,
    now,
    expiresAt: new Date('2026-10-21T00:05:00.000Z'),
  });

  await expect(verifyExecutionProxyToken(token, secret, now)).resolves.toEqual({
    execution_id: 'execution-1',
  });
});

test('rejects an expired or differently signed execution proxy token', async () => {
  const token = await issueExecutionProxyToken({
    executionId: 'execution-1',
    secret,
    now,
    expiresAt: new Date('2026-10-21T00:05:00.000Z'),
  });

  await expect(
    verifyExecutionProxyToken(
      token,
      secret,
      new Date('2026-10-21T00:05:01.000Z'),
    ),
  ).rejects.toThrow();
  await expect(
    verifyExecutionProxyToken(token, `${secret}-different`, now),
  ).rejects.toThrow();
});
