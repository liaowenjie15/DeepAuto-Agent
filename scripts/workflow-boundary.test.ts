import { afterEach, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkflowBoundary } from './workflow-boundary';

const directories: string[] = [];
const repositoryRoot = process.cwd();
const executionWorkflowPath = join(
  repositoryRoot,
  '.github',
  'workflows',
  'deepauto-execute.yml',
);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(workflow: string): string {
  const root = mkdtempSync(join(tmpdir(), 'deepauto-workflow-boundary-'));
  directories.push(root);
  const workflowDirectory = join(root, '.github', 'workflows');
  mkdirSync(workflowDirectory, { recursive: true });
  writeFileSync(join(workflowDirectory, 'deepauto-execute.yml'), workflow);
  return root;
}

it('accepts the managed execution workflow', () => {
  expect(inspectWorkflowBoundary(repositoryRoot)).toEqual([]);
});

it('requires an execution-bound dispatch input', () => {
  const workflow = readFileSync(executionWorkflowPath, 'utf8');
  const root = fixture(workflow.replace('execution_id:', 'run_id:'));

  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: requires a workflow_dispatch execution_id input',
  );
});

it('requires an execution-bound workflow run name', () => {
  const workflow = readFileSync(executionWorkflowPath, 'utf8');
  const executionRunName =
    'run-name: DeepAuto execution $' + '{{ inputs.execution_id }}';
  const root = fixture(
    workflow.replace(executionRunName, 'run-name: DeepAuto execution'),
  );

  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must name runs from the workflow_dispatch execution_id input',
  );
});

it('requires the versioned prompt layer artifact', () => {
  const workflow = readFileSync(executionWorkflowPath, 'utf8');
  const root = fixture(workflow.replace("'prompt_layers\\t%s'", "'layers\\t%s'"));

  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must record the prompt_layers artifact',
  );
});

it('rejects direct credentials and datastore access', () => {
  const workflow = readFileSync(executionWorkflowPath, 'utf8');
  const root = fixture(
    `${workflow}\n      - run: echo \${{ secrets.DEEPAUTO_TOKEN }} && psql "\${DATABASE_URL}"\n`,
  );

  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must not reference GitHub Secrets directly',
  );
  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must not include a direct database or Redis connection',
  );
});

it('rejects merges and production deployment', () => {
  const workflow = readFileSync(executionWorkflowPath, 'utf8');
  const root = fixture(
    `${workflow}\n      - run: gh pr merge 123 && vercel --prod\n`,
  );

  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must not merge pull requests or change repository settings',
  );
  expect(inspectWorkflowBoundary(root)).toContain(
    '.github/workflows/deepauto-execute.yml: must not deploy production infrastructure',
  );
});
