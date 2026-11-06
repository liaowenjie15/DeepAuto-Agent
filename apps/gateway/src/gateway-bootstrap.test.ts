import { expect, test } from 'bun:test';
import { parseGatewayConfiguration } from './gateway-bootstrap';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://deepauto:deepauto_local@localhost:5432/deepauto',
  GITHUB_WEBHOOK_SECRET: 'a'.repeat(48),
  GITHUB_WORKSPACE_ID: 'deepauto-local-pilot',
  GITHUB_BOT_MENTION: '@deepauto',
};

test('keeps the pilot paused when execution configuration is absent', () => {
  const configuration = parseGatewayConfiguration(baseEnvironment);

  expect(configuration.host).toBe('127.0.0.1');
  expect(configuration.port).toBe(3000);
  expect(configuration.appConfiguration.pilotAdmission).toEqual({
    enabled: false,
  });
  expect(configuration.appConfiguration.githubActions).toBeUndefined();
  expect(configuration.appConfiguration.codexProxy).toBeUndefined();
});

test('rejects enabling the pilot without its complete execution boundary', () => {
  expect(() =>
    parseGatewayConfiguration({
      ...baseEnvironment,
      DEEPAUTO_PILOT_ENABLED: 'true',
    }),
  ).toThrow('Gateway configuration is invalid');
});

test('rejects partially configured GitHub App credentials', () => {
  expect(() =>
    parseGatewayConfiguration({
      ...baseEnvironment,
      GITHUB_APP_ID: '123',
    }),
  ).toThrow('Gateway configuration is invalid');
});

test('rejects a partial GitHub Actions OIDC trust policy', () => {
  expect(() =>
    parseGatewayConfiguration({
      ...baseEnvironment,
      DEEPAUTO_ACTIONS_OIDC_AUDIENCE: 'deepauto-actions',
      DEEPAUTO_ACTIONS_OIDC_REPOSITORY: 'liaowenjie15/DeepAuto-Agent',
    }),
  ).toThrow('Gateway configuration is invalid');
});

test('requires the immutable repository ID in the GitHub Actions OIDC policy', () => {
  const configuration = parseGatewayConfiguration({
    ...baseEnvironment,
    DEEPAUTO_ACTIONS_OIDC_AUDIENCE: 'deepauto-actions',
    DEEPAUTO_ACTIONS_OIDC_REPOSITORY: 'liaowenjie15/DeepAuto-Agent',
    DEEPAUTO_ACTIONS_OIDC_REPOSITORY_ID: '1423344804',
    DEEPAUTO_ACTIONS_OIDC_WORKFLOW_REF:
      'liaowenjie15/DeepAuto-Agent/.github/workflows/deepauto-execute.yml@refs/heads/main',
    DEEPAUTO_ACTIONS_OIDC_REF: 'refs/heads/main',
    DEEPAUTO_ACTIONS_OIDC_EVENT_NAME: 'workflow_dispatch',
  });

  expect(configuration.appConfiguration.githubActions?.oidcTrustPolicy).toEqual(
    {
      audience: 'deepauto-actions',
      repository: 'liaowenjie15/DeepAuto-Agent',
      repositoryId: '1423344804',
      workflowRef:
        'liaowenjie15/DeepAuto-Agent/.github/workflows/deepauto-execute.yml@refs/heads/main',
      ref: 'refs/heads/main',
      eventName: 'workflow_dispatch',
    },
  );
});
