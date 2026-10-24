import { z } from 'zod';

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
