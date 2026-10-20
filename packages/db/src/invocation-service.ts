import type { Invocation, PrismaClient } from './generated/prisma/client';

export type CreateInvocationJobInput = {
  source: 'feishu' | 'github';
  workspaceId: string;
  actorId: string;
  conversationKey: string;
  anchor: 'message' | 'issue' | 'pull-request' | 'comment';
  instruction: string;
  sourceEventId: string;
  receivedAt: Date;
  idempotencyKey: string;
};

export type InvocationJob = {
  invocation: Invocation;
  job: {
    id: string;
    conversationKey: string;
    idempotencyKey: string;
    status: string;
  };
  created: boolean;
};

const sourceMap = {
  feishu: 'FEISHU',
  github: 'GITHUB',
} as const;

const anchorMap = {
  message: 'MESSAGE',
  issue: 'ISSUE',
  'pull-request': 'PULL_REQUEST',
  comment: 'COMMENT',
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

export async function createOrGetInvocationJob(
  prisma: PrismaClient,
  input: CreateInvocationJobInput,
): Promise<InvocationJob> {
  try {
    const invocation = await prisma.$transaction(async (transaction) => {
      const created = await transaction.invocation.create({
        data: {
          source: sourceMap[input.source],
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          conversationKey: input.conversationKey,
          anchor: anchorMap[input.anchor],
          instruction: input.instruction,
          sourceEventId: input.sourceEventId,
          receivedAt: input.receivedAt,
          job: {
            create: {
              conversationKey: input.conversationKey,
              idempotencyKey: input.idempotencyKey,
            },
          },
        },
        include: { job: true },
      });

      if (!created.job) {
        throw new Error('Created invocation has no job');
      }

      await transaction.outboxEvent.create({
        data: {
          jobId: created.job.id,
          kind: 'JOB_ENQUEUE',
          queueSequence: 0,
          dedupeKey: `job:${created.job.id}:enqueue`,
        },
      });

      return created;
    });

    if (!invocation.job) {
      throw new Error('Created invocation has no job');
    }

    return { invocation, job: invocation.job, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const invocation = await prisma.invocation.findUnique({
      where: {
        source_sourceEventId: {
          source: sourceMap[input.source],
          sourceEventId: input.sourceEventId,
        },
      },
      include: { job: true },
    });

    if (invocation?.job) {
      return { invocation, job: invocation.job, created: false };
    }

    const job = await prisma.job.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { invocation: true },
    });

    if (job) {
      return { invocation: job.invocation, job, created: false };
    }

    throw error;
  }
}
