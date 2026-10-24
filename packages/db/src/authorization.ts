import type { InboundInvocation, Invocation } from '@deepauto/contracts';
import type { MemberRole, PrismaClient } from './generated/prisma/client';

export type AuthorizedInvocation = Invocation & {
  memberRole: MemberRole;
};

export async function authorizeInboundInvocation(
  prisma: PrismaClient,
  invocation: InboundInvocation,
): Promise<AuthorizedInvocation | null> {
  const member = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: invocation.workspaceId,
      active: true,
      ...(invocation.source === 'feishu'
        ? { larkOpenId: invocation.providerActorId }
        : { githubUserId: invocation.providerActorId }),
    },
    select: { id: true, role: true },
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
    memberRole: member.role,
    conversationKey: invocation.conversationKey,
    anchor: invocation.anchor,
    instruction: invocation.instruction,
    sourceEventId: invocation.sourceEventId,
    receivedAt: invocation.receivedAt,
  };
}
