import type { InboundInvocation, Invocation } from '@deepauto/contracts';
import type { PrismaClient } from './generated/prisma/client';

export async function authorizeInboundInvocation(
  prisma: PrismaClient,
  invocation: InboundInvocation,
): Promise<Invocation | null> {
  const member = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: invocation.workspaceId,
      active: true,
      ...(invocation.source === 'feishu'
        ? { larkOpenId: invocation.providerActorId }
        : { githubUserId: invocation.providerActorId }),
    },
    select: { id: true },
  });

  if (!member) return null;

  if (invocation.source === 'github') {
    if (!invocation.repositoryId) return null;
    const repository = await prisma.workspaceRepository.findUnique({
      where: {
        workspaceId_providerRepositoryId: {
          workspaceId: invocation.workspaceId,
          providerRepositoryId: invocation.repositoryId,
        },
      },
      select: { enabled: true },
    });
    if (!repository?.enabled) return null;
  }

  return {
    source: invocation.source,
    workspaceId: invocation.workspaceId,
    actorId: member.id,
    conversationKey: invocation.conversationKey,
    anchor: invocation.anchor,
    instruction: invocation.instruction,
    sourceEventId: invocation.sourceEventId,
    receivedAt: invocation.receivedAt,
  };
}
