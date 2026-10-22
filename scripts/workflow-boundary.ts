import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXECUTION_WORKFLOW_PATH = '.github/workflows/deepauto-execute.yml';

const FORBIDDEN_PATTERNS = [
  {
    message: 'must not reference GitHub Secrets directly',
    pattern: /\bsecrets\./i,
  },
  {
    message: 'must not include a direct database or Redis connection',
    pattern:
      /\b(?:DATABASE_URL|POSTGRES(?:QL)?(?:_|:)|MYSQL(?:_|:)|MONGODB(?:_|:)|REDIS_URL|redis:\/\/)/i,
  },
  {
    message: 'must not include a long-lived user or provider credential',
    pattern:
      /\b(?:FEISHU|LARK|OPENAI|ANTHROPIC|SLACK)_(?:USER_)?(?:ACCESS_)?(?:TOKEN|KEY)\b/i,
  },
  {
    message: 'must not merge pull requests or change repository settings',
    pattern:
      /\bgh\s+(?:pr\s+merge|repo\s+(?:edit|archive|delete))\b|\bgh\s+api\b[^\n]*\/merges\b/i,
  },
  {
    message: 'must not deploy production infrastructure',
    pattern:
      /\b(?:kubectl|helm|terraform)\s+(?:apply|upgrade)\b|\bvercel\b[^\n]*--prod\b|\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:deploy|release)\b/i,
  },
] as const;

function hasRequiredExecutionInput(workflow: string): boolean {
  return /^ {2}workflow_dispatch:\n(?:^ {4}.*\n)*?^ {4}inputs:\n(?:^ {6}.*\n)*?^ {6}execution_id:\n(?:^ {8}.*\n)*?^ {8}required: true$/m.test(
    workflow,
  );
}

export function inspectWorkflowBoundary(root: string): string[] {
  const workflowPath = join(root, EXECUTION_WORKFLOW_PATH);
  if (!existsSync(workflowPath)) {
    return [`${EXECUTION_WORKFLOW_PATH}: missing execution workflow`];
  }

  const workflow = readFileSync(workflowPath, 'utf8');
  const errors: string[] = [];

  if (!hasRequiredExecutionInput(workflow)) {
    errors.push(
      `${EXECUTION_WORKFLOW_PATH}: requires a workflow_dispatch execution_id input`,
    );
  }
  if (!/EXECUTION_ID:\s*\$\{\{\s*inputs\.execution_id\s*}}/.test(workflow)) {
    errors.push(
      `${EXECUTION_WORKFLOW_PATH}: must pass execution_id to the runner as EXECUTION_ID`,
    );
  }
  if (
    !/ACTIONS_ID_TOKEN_REQUEST_TOKEN/.test(workflow) ||
    !/ACTIONS_ID_TOKEN_REQUEST_URL/.test(workflow)
  ) {
    errors.push(
      `${EXECUTION_WORKFLOW_PATH}: must authenticate Gateway calls with GitHub OIDC`,
    );
  }
  if (
    !/github\/actions\/executions\/\$\{EXECUTION_ID}\/bootstrap/.test(
      workflow,
    ) ||
    !/github\/actions\/executions\/\$\{EXECUTION_ID}\/callback/.test(workflow)
  ) {
    errors.push(
      `${EXECUTION_WORKFLOW_PATH}: must bootstrap and callback through the execution-bound Gateway endpoints`,
    );
  }

  for (const { message, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(workflow)) {
      errors.push(`${EXECUTION_WORKFLOW_PATH}: ${message}`);
    }
  }

  return errors;
}
