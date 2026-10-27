import { createHash } from 'node:crypto';
import { z } from 'zod';

const capabilityIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/);

export const executionCapabilitySchema = z.object({
  id: capabilityIdSchema,
  allowedSources: z.array(z.enum(['github'])).min(1),
  repositoryAllowlist: z.literal('workspace-enabled'),
  executor: z.literal('github-actions-codex'),
  workflow: z.literal('deepauto-execute.yml'),
  workflowPath: z.literal('.github/workflows/deepauto-execute.yml'),
  workflowRef: z.literal('main'),
  promptAdapter: z.literal('gateway-bootstrap-v1'),
  toolProfile: z.literal('codex-repository-change-pr'),
  sandbox: z.literal('workspace-write'),
  allowsAdditionalWritableDirectories: z.literal(false),
  usesUserConfig: z.literal(false),
  persistsSession: z.literal(false),
  maximumDurationMinutes: z.number().int().positive().max(60),
  writePolicy: z.literal('pull-request-only'),
  validationTargets: z.array(z.literal('verify:targets')).min(1),
  callbackSchema: z.literal('execution-result.v1'),
  owner: z.string().trim().min(1),
  risk: z.literal('high'),
  securityReview: z.literal('required'),
});

export type ExecutionCapability = z.infer<typeof executionCapabilitySchema>;

export const executionCapabilitySnapshotSchema = z.object({
  id: capabilityIdSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: executionCapabilitySchema,
});

export type ExecutionCapabilitySnapshot = z.infer<
  typeof executionCapabilitySnapshotSchema
>;

export const registeredExecutionCapabilities: readonly ExecutionCapability[] = [
  {
    id: 'repository.change-pr.v1',
    allowedSources: ['github'],
    repositoryAllowlist: 'workspace-enabled',
    executor: 'github-actions-codex',
    workflow: 'deepauto-execute.yml',
    workflowPath: '.github/workflows/deepauto-execute.yml',
    workflowRef: 'main',
    promptAdapter: 'gateway-bootstrap-v1',
    toolProfile: 'codex-repository-change-pr',
    sandbox: 'workspace-write',
    allowsAdditionalWritableDirectories: false,
    usesUserConfig: false,
    persistsSession: false,
    maximumDurationMinutes: 15,
    writePolicy: 'pull-request-only',
    validationTargets: ['verify:targets'],
    callbackSchema: 'execution-result.v1',
    owner: 'platform-security',
    risk: 'high',
    securityReview: 'required',
  },
];

export const defaultExecutionCapabilityId = 'repository.change-pr.v1';

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateExecutionCapabilityRegistry(
  capabilities: readonly unknown[],
): ExecutionCapability[] {
  const parsed = capabilities.map((capability) =>
    executionCapabilitySchema.parse(capability),
  );
  const ids = new Set<string>();
  for (const capability of parsed) {
    if (ids.has(capability.id)) {
      throw new Error(
        `Execution capability is registered twice: ${capability.id}`,
      );
    }
    ids.add(capability.id);
  }
  if (!ids.has(defaultExecutionCapabilityId)) {
    throw new Error(
      `Default execution capability is not registered: ${defaultExecutionCapabilityId}`,
    );
  }
  return parsed;
}

export function resolveExecutionCapability(
  id = defaultExecutionCapabilityId,
  capabilities: readonly unknown[] = registeredExecutionCapabilities,
): ExecutionCapability {
  const capability = validateExecutionCapabilityRegistry(capabilities).find(
    (entry) => entry.id === id,
  );
  if (!capability)
    throw new Error(`Execution capability is not registered: ${id}`);
  return capability;
}

export function createExecutionCapabilitySnapshot(
  capability: ExecutionCapability,
): ExecutionCapabilitySnapshot {
  const policy = executionCapabilitySchema.parse(capability);
  return executionCapabilitySnapshotSchema.parse({
    id: policy.id,
    policyHash: createHash('sha256').update(canonicalize(policy)).digest('hex'),
    policy,
  });
}

export function allowsExecutionCapabilitySource(
  capability: ExecutionCapability,
  source: string,
): boolean {
  return capability.allowedSources.includes(source as 'github');
}
