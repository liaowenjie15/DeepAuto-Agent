import type { InboundInvocation, Invocation } from '@deepauto/contracts';
import { z } from 'zod';

const identifierSchema = z.string().trim().min(1);

const pilotAdmissionConfigurationSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      allowedWorkspaceIds: z.array(identifierSchema).min(1),
      allowedMemberIds: z.array(identifierSchema).min(1),
      allowedRepositoryIds: z.array(identifierSchema).min(1),
    })
    .strict(),
]);

export type PilotAdmissionConfiguration = z.input<
  typeof pilotAdmissionConfigurationSchema
>;

export type PilotAdmissionDecision =
  | { accepted: true }
  | {
      accepted: false;
      reason:
        | 'paused'
        | 'workspace_not_allowed'
        | 'member_not_allowed'
        | 'repository_not_allowed';
    };

export function evaluatePilotAdmission(
  input: PilotAdmissionConfiguration,
  inbound: InboundInvocation,
  authorized: Invocation,
): PilotAdmissionDecision {
  const configuration = pilotAdmissionConfigurationSchema.parse(input);
  if (!configuration.enabled) return { accepted: false, reason: 'paused' };

  if (!configuration.allowedWorkspaceIds.includes(authorized.workspaceId)) {
    return { accepted: false, reason: 'workspace_not_allowed' };
  }
  if (!configuration.allowedMemberIds.includes(authorized.actorId)) {
    return { accepted: false, reason: 'member_not_allowed' };
  }
  if (
    inbound.source !== 'github' ||
    !inbound.repositoryId ||
    !configuration.allowedRepositoryIds.includes(inbound.repositoryId)
  ) {
    return { accepted: false, reason: 'repository_not_allowed' };
  }

  return { accepted: true };
}
