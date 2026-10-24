import { expect, test } from 'bun:test';
import type { JWTPayload } from 'jose';
import {
  assertGitHubActionsOidcClaims,
  verifyGitHubActionsOidcToken,
} from './actions-oidc';

const policy = {
  audience: 'deepauto-actions',
  repository: 'liaowenjie15/deepauto-harness-sandbox',
  workflowRef:
    'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
};

const claims: JWTPayload = {
  repository: policy.repository,
  workflow_ref: policy.workflowRef,
  ref: policy.ref,
  event_name: policy.eventName,
  run_id: '12345',
  run_attempt: 1,
};

test('accepts only the configured GitHub Actions repository and workflow', () => {
  expect(assertGitHubActionsOidcClaims(claims, policy)).toEqual({
    repository: policy.repository,
    workflow_ref: policy.workflowRef,
    ref: policy.ref,
    event_name: policy.eventName,
    run_id: '12345',
    run_attempt: 1,
  });
  expect(() =>
    assertGitHubActionsOidcClaims(
      { ...claims, workflow_ref: 'untrusted-workflow' },
      policy,
    ),
  ).toThrow('workflow claim is not trusted');
  expect(() =>
    assertGitHubActionsOidcClaims(
      { ...claims, ref: 'refs/heads/feature' },
      policy,
    ),
  ).toThrow('ref claim is not trusted');
});

test('passes the configured audience to the JWT verifier before trusting claims', async () => {
  await expect(
    verifyGitHubActionsOidcToken('oidc-token', policy, async (token, input) => {
      expect(token).toBe('oidc-token');
      expect(input).toEqual(policy);
      return claims;
    }),
  ).resolves.toMatchObject({ run_id: '12345', run_attempt: 1 });
});
