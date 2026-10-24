import { expect, it } from 'bun:test';
import { createReviewPlan, requiresExecutionSafetyReview } from './review-plan';

it('requires an execution safety review for registered high-risk paths', () => {
  expect(requiresExecutionSafetyReview('apps/gateway/src/app.ts')).toBe(true);
  expect(requiresExecutionSafetyReview('.github/workflows/validate.yml')).toBe(
    true,
  );
  expect(
    requiresExecutionSafetyReview('packages/db/src/execution-service.ts'),
  ).toBe(true);
});

it('keeps ordinary documentation changes on the general review path', () => {
  expect(
    createReviewPlan(['docs/git-tasks/adapt/05-two-layer-code-review.md']),
  ).toEqual({
    schemaVersion: 1,
    changedPaths: ['docs/git-tasks/adapt/05-two-layer-code-review.md'],
    reviewers: ['code-reviewer'],
    blockerWaiver: {
      requiresWrittenApproval: true,
      allowedApprovers: ['repository-maintainer', 'security-owner'],
    },
    selfRepair: {
      allowed: true,
      maxReReviewRounds: 2,
      unresolvedBlockers: 'human-handoff',
    },
  });
});

it('adds the safety reviewer once for a mixed diff and normalizes paths', () => {
  expect(
    createReviewPlan([
      ' packages/github/src/index.ts ',
      'docs/readme.md',
      'packages/github/src/index.ts',
    ]),
  ).toMatchObject({
    changedPaths: ['docs/readme.md', 'packages/github/src/index.ts'],
    reviewers: ['code-reviewer', 'execution-safety-reviewer'],
  });
});
