import { z } from 'zod';

export * from './capability-registry';

export const invocationSchema = z.object({
  source: z.enum(['feishu', 'github']),
  workspaceId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  conversationKey: z.string().trim().min(1),
  anchor: z.enum(['message', 'issue', 'pull-request', 'comment']),
  instruction: z.string().trim().min(1),
  sourceEventId: z.string().trim().min(1),
  receivedAt: z.iso.datetime(),
});

export type Invocation = z.infer<typeof invocationSchema>;

export const inboundInvocationSchema = invocationSchema.extend({
  idempotencyKey: z.string().trim().min(1),
  providerActorId: z.string().trim().min(1),
  repositoryId: z.string().trim().min(1).optional(),
});

export type InboundInvocation = z.infer<typeof inboundInvocationSchema>;

const executionEventBaseSchema = z.object({
  attemptId: z.string().trim().min(1),
});

export const executionArtifactNameSchema = z.enum([
  'diff',
  'test_result',
  'commit_sha',
  'pull_request',
  'prompt_layers',
  'workspace',
]);

export type ExecutionArtifactName = z.infer<typeof executionArtifactNameSchema>;

export const executionTerminalStatusSchema = z.enum([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

export type ExecutionTerminalStatus = z.infer<
  typeof executionTerminalStatusSchema
>;

export const executionFailureCategorySchema = z.enum([
  'VALIDATION_FAILED',
  'POLICY_REJECTED',
  'CANCELLED',
  'TIMEOUT',
  'INFRASTRUCTURE_FAILED',
  'CALLBACK_REJECTED',
]);

export type ExecutionFailureCategory = z.infer<
  typeof executionFailureCategorySchema
>;

export const executionLogReferenceSchema = z
  .object({
    provider: z.enum(['github_actions', 'local_sandbox']),
    reference: z.string().trim().min(1).max(2_048),
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine((reference, context) => {
    if (reference.provider === 'local_sandbox' && !reference.expiresAt) {
      context.addIssue({
        code: 'custom',
        message: 'Local Sandbox log references require an expiry',
      });
    }
  });

export type ExecutionLogReference = z.infer<typeof executionLogReferenceSchema>;

export const executionTestSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .superRefine((summary, context) => {
    if (summary.total !== summary.passed + summary.failed + summary.skipped) {
      context.addIssue({
        code: 'custom',
        message: 'Test summary totals must add up',
      });
    }
  });

export type ExecutionTestSummary = z.infer<typeof executionTestSummarySchema>;

const sensitiveSummaryPatterns = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb):\/\/\S+/i,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]+/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/i,
];

export function isSafeExecutionSummary(value: string): boolean {
  return !sensitiveSummaryPatterns.some((pattern) => pattern.test(value));
}

const safeExecutionSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isSafeExecutionSummary, {
    message: 'Execution summary contains sensitive material',
  });

export const executionArtifactReferenceSchema = z.object({
  name: executionArtifactNameSchema,
  reference: z.string().trim().min(1).max(2_048),
});

export type ExecutionArtifactReference = z.infer<
  typeof executionArtifactReferenceSchema
>;

const retryableFailureCategories = new Set<ExecutionFailureCategory>([
  'INFRASTRUCTURE_FAILED',
  'TIMEOUT',
]);

export function isRetryableExecutionFailure(
  category: ExecutionFailureCategory,
): boolean {
  return retryableFailureCategories.has(category);
}

export const executionResultSchema = z
  .object({
    status: executionTerminalStatusSchema,
    failureCategory: executionFailureCategorySchema.optional(),
    safeSummary: safeExecutionSummarySchema,
    retryable: z.boolean(),
    logReference: executionLogReferenceSchema.optional(),
    testSummary: executionTestSummarySchema.optional(),
    artifacts: z.array(executionArtifactReferenceSchema).max(16).default([]),
    finishedAt: z.iso.datetime(),
  })
  .superRefine((result, context) => {
    const artifactNames = new Set<string>();
    for (const artifact of result.artifacts) {
      if (artifactNames.has(artifact.name)) {
        context.addIssue({
          code: 'custom',
          message: 'Execution result cannot repeat an artifact name',
        });
      }
      artifactNames.add(artifact.name);
    }

    if (result.status === 'COMPLETED') {
      if (result.failureCategory || result.retryable) {
        context.addIssue({
          code: 'custom',
          message: 'Completed results cannot be failed or retryable',
        });
      }
      return;
    }

    if (!result.failureCategory) {
      context.addIssue({
        code: 'custom',
        message: 'Non-completed results require a failure category',
      });
      return;
    }

    if (
      result.retryable !== isRetryableExecutionFailure(result.failureCategory)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retryable does not match the failure category policy',
      });
    }
    if (
      result.status === 'CANCELLED' &&
      result.failureCategory !== 'CANCELLED'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cancelled results require the CANCELLED category',
      });
    }
    if (result.status === 'TIMED_OUT' && result.failureCategory !== 'TIMEOUT') {
      context.addIssue({
        code: 'custom',
        message: 'Timed out results require the TIMEOUT category',
      });
    }
    if (
      result.failureCategory === 'CANCELLED' &&
      result.status !== 'CANCELLED'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The CANCELLED category requires a cancelled result',
      });
    }
    if (result.failureCategory === 'TIMEOUT' && result.status !== 'TIMED_OUT') {
      context.addIssue({
        code: 'custom',
        message: 'The TIMEOUT category requires a timed out result',
      });
    }
  });

export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const executionEventSchema = z.discriminatedUnion('type', [
  executionEventBaseSchema.extend({ type: z.literal('started') }),
  executionEventBaseSchema.extend({
    type: z.literal('progress'),
    message: z.string().trim().min(1),
  }),
  executionEventBaseSchema.extend({
    type: z.literal('artifact'),
    name: executionArtifactNameSchema,
    value: z.string().trim().min(1),
  }),
  executionEventBaseSchema.extend({ type: z.literal('completed') }),
  executionEventBaseSchema.extend({
    type: z.literal('failed'),
    reason: z.string().trim().min(1),
  }),
]);

export type ExecutionEvent = z.infer<typeof executionEventSchema>;
