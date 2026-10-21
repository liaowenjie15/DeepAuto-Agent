import { expect, test } from 'bun:test';
import {
  evaluatePilotAdmission,
  type PilotAdmissionConfiguration,
} from './pilot-admission';

const inbound = {
  source: 'github',
  workspaceId: 'workspace-1',
  actorId: 'provider-user-1',
  providerActorId: 'provider-user-1',
  repositoryId: 'repository-1',
  conversationKey: 'github:repository-1:issue-1',
  anchor: 'issue',
  instruction: 'Fix the failing test',
  sourceEventId: 'delivery-1',
  idempotencyKey: 'github:delivery-1',
  receivedAt: '2026-10-21T00:00:00.000Z',
} as const;

const authorized = {
  source: 'github',
  workspaceId: 'workspace-1',
  actorId: 'member-1',
  conversationKey: inbound.conversationKey,
  anchor: 'issue',
  instruction: inbound.instruction,
  sourceEventId: inbound.sourceEventId,
  receivedAt: inbound.receivedAt,
} as const;

const activeConfiguration: PilotAdmissionConfiguration = {
  enabled: true,
  allowedWorkspaceIds: ['workspace-1'],
  allowedMemberIds: ['member-1'],
  allowedRepositoryIds: ['repository-1'],
};

test('accepts only the configured GitHub workspace, member, and repository', () => {
  expect(
    evaluatePilotAdmission(activeConfiguration, inbound, authorized),
  ).toEqual({ accepted: true });
  expect(
    evaluatePilotAdmission(
      { ...activeConfiguration, allowedMemberIds: ['member-2'] },
      inbound,
      authorized,
    ),
  ).toEqual({ accepted: false, reason: 'member_not_allowed' });
  expect(
    evaluatePilotAdmission(
      { ...activeConfiguration, allowedRepositoryIds: ['repository-2'] },
      inbound,
      authorized,
    ),
  ).toEqual({ accepted: false, reason: 'repository_not_allowed' });
});

test('uses a fail-closed paused configuration and rejects incomplete active scope', () => {
  expect(
    evaluatePilotAdmission({ enabled: false }, inbound, authorized),
  ).toEqual({ accepted: false, reason: 'paused' });
  expect(() =>
    evaluatePilotAdmission(
      {
        enabled: true,
        allowedWorkspaceIds: ['workspace-1'],
        allowedMemberIds: [],
        allowedRepositoryIds: ['repository-1'],
      },
      inbound,
      authorized,
    ),
  ).toThrow();
});
