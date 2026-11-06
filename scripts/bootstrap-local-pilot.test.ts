import { expect, test } from 'bun:test';
import { MemberRole } from '../packages/db/src/index';
import {
  bootstrapLocalPilot,
  parsePilotBootstrapInput,
} from './bootstrap-local-pilot';

test('rejects incomplete local pilot bootstrap configuration', () => {
  expect(() => parsePilotBootstrapInput({})).toThrow(
    'Local pilot bootstrap configuration is invalid',
  );
});

test('upserts the confirmed local pilot authorization scope', async () => {
  const calls: Array<{ model: string; input: unknown }> = [];
  const result = await bootstrapLocalPilot(
    {
      $transaction: async (
        callback: (transaction: never) => Promise<unknown>,
      ) =>
        callback({
          workspace: {
            upsert: async (input: unknown) => {
              calls.push({ model: 'workspace', input });
            },
          },
          workspaceMember: {
            upsert: async (input: unknown) => {
              calls.push({ model: 'workspaceMember', input });
              return { id: 'member-1' };
            },
          },
          workspaceRepository: {
            upsert: async (input: unknown) => {
              calls.push({ model: 'workspaceRepository', input });
              return { id: 'repository-1' };
            },
          },
          auditEvent: {
            create: async (input: unknown) => {
              calls.push({ model: 'auditEvent', input });
            },
          },
        } as never),
    } as never,
    {
      DATABASE_URL: 'postgresql://deepauto:password@localhost:5432/deepauto',
      DEEPAUTO_PILOT_WORKSPACE_ID: 'deepauto-local-pilot',
      DEEPAUTO_PILOT_GITHUB_USER_ID: '250161618',
      DEEPAUTO_PILOT_GITHUB_LOGIN: 'liaowenjie15',
      DEEPAUTO_PILOT_REPOSITORY_ID: '1423344804',
    },
  );

  expect(result).toEqual({
    memberId: 'member-1',
    repositoryId: 'repository-1',
  });
  expect(calls).toEqual([
    {
      model: 'workspace',
      input: {
        where: { id: 'deepauto-local-pilot' },
        update: {},
        create: { id: 'deepauto-local-pilot' },
      },
    },
    {
      model: 'workspaceMember',
      input: {
        where: {
          workspaceId_githubUserId: {
            workspaceId: 'deepauto-local-pilot',
            githubUserId: '250161618',
          },
        },
        update: {
          role: MemberRole.ADMIN,
          active: true,
          githubLogin: 'liaowenjie15',
        },
        create: {
          workspaceId: 'deepauto-local-pilot',
          role: MemberRole.ADMIN,
          active: true,
          githubUserId: '250161618',
          githubLogin: 'liaowenjie15',
        },
      },
    },
    {
      model: 'workspaceRepository',
      input: {
        where: {
          workspaceId_providerRepositoryId: {
            workspaceId: 'deepauto-local-pilot',
            providerRepositoryId: '1423344804',
          },
        },
        update: { enabled: true },
        create: {
          workspaceId: 'deepauto-local-pilot',
          providerRepositoryId: '1423344804',
          enabled: true,
        },
      },
    },
    {
      model: 'auditEvent',
      input: {
        data: {
          workspaceId: 'deepauto-local-pilot',
          actorId: 'member-1',
          action: 'pilot.workspace_bootstrap_applied',
          metadata: {
            provider: 'github',
            githubUserId: '250161618',
            providerRepositoryId: '1423344804',
            role: MemberRole.ADMIN,
          },
        },
      },
    },
  ]);
});
