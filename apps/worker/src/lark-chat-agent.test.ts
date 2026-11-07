import { beforeEach, expect, mock, test } from 'bun:test';
import type { LarkChatConfiguration, LarkChatInput } from './lark-chat-agent';

let accessToken: string | undefined;
let capturedInstructions = '';
let capturedPrompt = '';
let capturedToolResult: unknown;
let failAfterTool = false;
let agentGenerateCount = 0;
let wikiResolution: unknown = {
  node: { obj_type: 'docx', obj_token: 'doc123456' },
};
let readDocument:
  | ((input: { documentId: string }) => Promise<unknown>)
  | undefined;

const dataExecute = mock(
  async (operation: { action: string; [key: string]: unknown }) =>
    operation.action === 'wiki.resolve'
      ? wikiResolution
      : { content: '私人文档正文' },
);
const getLarkUserAccessToken = mock(async () => accessToken);
const createLarkOAuthState = mock(async () => 'oauth-state');

mock.module('@deepauto/db', () => ({
  claimLarkToolWrite: mock(),
  consumeLarkWriteConfirmation: mock(),
  createLarkOAuthState,
  createLarkPullRequestJob: mock(),
  finishLarkToolWrite: mock(),
  getLarkUserAccessToken,
  requestLarkWriteConfirmation: mock(),
}));

mock.module('@deepauto/lark', () => ({
  createLarkDataClient: mock(() => ({ execute: dataExecute })),
  createLarkOAuthProvider: mock(() => ({
    authorizationUrl: () => 'https://open.feishu.cn/auth',
    refresh: mock(),
  })),
  larkDataScope: {
    'doc.read': 'docx:document:readonly',
    'wiki.resolve': 'wiki:wiki:readonly',
  },
  larkDataTarget: (operation: { documentId?: string; nodeToken?: string }) =>
    operation.documentId ?? operation.nodeToken ?? '',
  requestForLarkDataOperation: mock(),
  resolvedWikiDocxDocumentId: (result: unknown) => {
    if (
      result &&
      typeof result === 'object' &&
      'node' in result &&
      result.node &&
      typeof result.node === 'object' &&
      'obj_type' in result.node &&
      'obj_token' in result.node &&
      result.node.obj_type === 'docx' &&
      typeof result.node.obj_token === 'string'
    ) {
      return result.node.obj_token;
    }
    return undefined;
  },
}));

class TestToolLoopAgent {
  constructor(input: {
    instructions: string;
    tools: {
      readDocument: {
        execute: (input: { documentId: string }) => Promise<unknown>;
      };
    };
  }) {
    capturedInstructions = input.instructions;
    readDocument = input.tools.readDocument.execute;
  }

  async generate(input: { prompt: string }): Promise<{ text: string }> {
    agentGenerateCount += 1;
    capturedPrompt = input.prompt;
    if (input.prompt.includes('[已授权资源的只读结果')) {
      if (failAfterTool) throw new Error('model final response failed');
      return { text: '模型摘要' };
    }
    capturedToolResult = await readDocument?.({ documentId: 'doc123456' });
    if (failAfterTool) throw new Error('model final response failed');
    return { text: '模型摘要' };
  }
}

mock.module('ai', () => ({
  ToolLoopAgent: TestToolLoopAgent,
  isStepCount: mock(),
  tool: <T>(definition: T) => definition,
}));

mock.module('@ai-sdk/openai', () => ({
  createOpenAI: mock(() => () => ({})),
}));

const { runLarkChatAgent } = await import('./lark-chat-agent');

const configuration: LarkChatConfiguration = {
  appId: 'cli_test_app',
  appSecret: 'test-secret',
  tenantKey: 'tenant_test',
  workspaceId: 'workspace-1',
  repositoryId: 'repository-1',
  redirectUri: 'https://example.test/callback',
  cipher: {} as LarkChatConfiguration['cipher'],
  responsesUrl: 'https://model.example.test/v1/responses',
  apiKey: 'test-api-key',
  model: 'test-model',
  botResourceTokens: [],
};

const input: LarkChatInput = {
  invocationId: 'invocation-1',
  workspaceId: 'workspace-1',
  actorId: 'member-1',
  senderOpenId: 'ou_user',
  conversationKey: 'feishu:tenant_test:chat-1:direct',
  chatType: 'p2p',
  instruction: '请阅读 doc123456 并总结。',
};

const prisma = {
  workspaceMember: { findFirst: mock(async () => ({ id: 'member-1' })) },
  larkUserConnection: { findUnique: mock(async () => null) },
  auditEvent: { create: mock(async () => undefined) },
} as never;

beforeEach(() => {
  accessToken = 'user-access-token';
  capturedInstructions = '';
  capturedPrompt = '';
  capturedToolResult = undefined;
  failAfterTool = false;
  agentGenerateCount = 0;
  wikiResolution = { node: { obj_type: 'docx', obj_token: 'doc123456' } };
  dataExecute.mockClear();
  getLarkUserAccessToken.mockClear();
  createLarkOAuthState.mockClear();
});

test('supplies an authorized private read result to the configured model', async () => {
  const result = await runLarkChatAgent(prisma, configuration, input);

  expect(capturedPrompt).toContain('[已授权资源的只读结果');
  expect(capturedInstructions).toContain('configured upstream model');
  expect(capturedToolResult).toBeUndefined();
  expect(result).toEqual({ text: '模型摘要', waitingPr: false });
  expect(dataExecute).toHaveBeenCalledTimes(1);
});

test('does not fetch private content without an authorized user or bot resource', async () => {
  accessToken = undefined;

  const result = await runLarkChatAgent(prisma, configuration, input);

  expect(dataExecute).not.toHaveBeenCalled();
  expect(agentGenerateCount).toBe(0);
  expect(createLarkOAuthState).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('请先完成飞书授权');
});

test('does not call the model when a read request omits a document identifier', async () => {
  const result = await runLarkChatAgent(prisma, configuration, {
    ...input,
    instruction: '请读取并总结这个文档。',
  });

  expect(result.text).toContain('documentId=');
  expect(agentGenerateCount).toBe(0);
  expect(dataExecute).not.toHaveBeenCalled();
});

test('does not re-read an authorized document when the model response fails', async () => {
  accessToken = 'user-access-token';
  failAfterTool = true;

  await expect(runLarkChatAgent(prisma, configuration, input)).rejects.toThrow(
    'model final response failed',
  );
  expect(dataExecute).toHaveBeenCalledTimes(1);
  expect(capturedToolResult).toBeUndefined();
});

test('resolves an authorized Wiki node before reading its Docx content', async () => {
  const result = await runLarkChatAgent(prisma, configuration, {
    ...input,
    instruction: '请阅读 https://example.feishu.cn/wiki/wiki12345 并总结。',
  });

  expect(result).toEqual({ text: '模型摘要', waitingPr: false });
  expect(dataExecute).toHaveBeenCalledTimes(2);
  expect(dataExecute.mock.calls[0]?.[0]).toEqual({
    action: 'wiki.resolve',
    nodeToken: 'wiki12345',
  });
  expect(dataExecute.mock.calls[1]?.[0]).toEqual({
    action: 'doc.read',
    documentId: 'doc123456',
  });
  expect(capturedPrompt).toContain('[已授权资源的只读结果');
});

test('creates one combined authorization request before resolving a Wiki node', async () => {
  accessToken = undefined;

  const result = await runLarkChatAgent(prisma, configuration, {
    ...input,
    instruction: '请阅读 https://example.feishu.cn/wiki/wiki12345 并总结。',
  });

  expect(dataExecute).not.toHaveBeenCalled();
  expect(agentGenerateCount).toBe(0);
  expect(createLarkOAuthState).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({
      scopes: ['wiki:wiki:readonly', 'docx:document:readonly'],
    }),
  );
  expect(result.text).toContain('请先完成飞书授权');
});

test('does not read Docx content or call the model for a non-Docx Wiki node', async () => {
  wikiResolution = { node: { obj_type: 'sheet', obj_token: 'sheet12345' } };

  const result = await runLarkChatAgent(prisma, configuration, {
    ...input,
    instruction: '请阅读 https://example.feishu.cn/wiki/wiki12345 并总结。',
  });

  expect(dataExecute).toHaveBeenCalledTimes(1);
  expect(agentGenerateCount).toBe(0);
  expect(result.text).toContain('不是可读取的 Docx 文档');
});

test('fails closed when a Wiki resolver response is invalid', async () => {
  wikiResolution = { node: { obj_type: 'docx' } };

  const result = await runLarkChatAgent(prisma, configuration, {
    ...input,
    instruction: '请阅读 https://example.feishu.cn/wiki/wiki12345 并总结。',
  });

  expect(dataExecute).toHaveBeenCalledTimes(1);
  expect(agentGenerateCount).toBe(0);
  expect(result.text).toContain('不是可读取的 Docx 文档');
});
