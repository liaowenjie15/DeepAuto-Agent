import { execFileSync } from 'node:child_process';

const highRiskPathPrefixes = [
  'apps/gateway/',
  'apps/worker/',
  'packages/db/',
  'packages/github/',
  'packages/runner-manager/',
  '.github/',
] as const;

export type ReviewRole = 'code-reviewer' | 'execution-safety-reviewer';

export type ReviewPlan = {
  schemaVersion: 1;
  changedPaths: string[];
  reviewers: ReviewRole[];
  blockerWaiver: {
    requiresWrittenApproval: true;
    allowedApprovers: ['repository-maintainer', 'security-owner'];
  };
  selfRepair: {
    allowed: true;
    maxReReviewRounds: 2;
    unresolvedBlockers: 'human-handoff';
  };
};

export function requiresExecutionSafetyReview(path: string): boolean {
  return highRiskPathPrefixes.some((prefix) => path.startsWith(prefix));
}

export function createReviewPlan(changedPaths: string[]): ReviewPlan {
  const paths = [...new Set(changedPaths.map((path) => path.trim()))]
    .filter(Boolean)
    .sort();
  const reviewers: ReviewRole[] = ['code-reviewer'];
  if (paths.some(requiresExecutionSafetyReview)) {
    reviewers.push('execution-safety-reviewer');
  }

  return {
    schemaVersion: 1,
    changedPaths: paths,
    reviewers,
    blockerWaiver: {
      requiresWrittenApproval: true,
      allowedApprovers: ['repository-maintainer', 'security-owner'],
    },
    selfRepair: {
      allowed: true,
      maxReReviewRounds: 2,
      unresolvedBlockers: 'human-handoff',
    },
  };
}

function changedPathsFromGit(baseRef: string): string[] {
  return execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

if (import.meta.main) {
  const baseRef = process.argv[2] ?? 'origin/main';
  const plan = createReviewPlan(changedPathsFromGit(baseRef));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
