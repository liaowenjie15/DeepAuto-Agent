import { z } from 'zod';

const apiResponse = z.object({ code: z.number(), data: z.unknown().optional() });
const tenantTokenResponse = z.object({
  code: z.literal(0),
  tenant_access_token: z.string().min(1),
  expire: z.number().positive(),
});
const tokenPart = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const fieldValues = z.record(z.string().min(1).max(128), z.unknown());

export type LarkDataOperation =
  | { action: 'doc.read'; documentId: string }
  | { action: 'doc.append'; documentId: string; text: string }
  | { action: 'base.list'; appToken: string; tableId: string }
  | { action: 'base.create'; appToken: string; tableId: string; fields: Record<string, unknown> }
  | { action: 'base.update'; appToken: string; tableId: string; recordId: string; fields: Record<string, unknown> }
  | { action: 'base.delete'; appToken: string; tableId: string; recordId: string };

export const larkDataScope: Record<LarkDataOperation['action'], string> = {
  'doc.read': 'docx:document:readonly',
  'doc.append': 'docx:document:write_only',
  'base.list': 'bitable:app:readonly',
  'base.create': 'base:record:create',
  'base.update': 'base:record:update',
  'base.delete': 'base:record:delete',
};

export function larkDataTarget(operation: LarkDataOperation): string {
  return 'documentId' in operation
    ? operation.documentId
    : `${operation.appToken}/${operation.tableId}${'recordId' in operation ? `/${operation.recordId}` : ''}`;
}

export function requestForLarkDataOperation(operation: LarkDataOperation): {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
} {
  if ('documentId' in operation) {
    const id = tokenPart.parse(operation.documentId);
    if (operation.action === 'doc.read') {
      return { path: `/docx/v1/documents/${id}/raw_content`, method: 'GET' };
    }
    const content = z.string().trim().min(1).max(10_000).parse(operation.text);
    return {
      path: `/docx/v1/documents/${id}/blocks/${id}/children`,
      method: 'POST',
      body: {
        children: [{ block_type: 2, text: { elements: [{ text_run: { content } }] } }],
      },
    };
  }
  const app = tokenPart.parse(operation.appToken);
  const table = tokenPart.parse(operation.tableId);
  const basePath = `/bitable/v1/apps/${app}/tables/${table}/records`;
  if (operation.action === 'base.list') {
    return { path: `${basePath}?page_size=20`, method: 'GET' };
  }
  if (operation.action === 'base.create') {
    const fields = fieldValues.parse(operation.fields);
    if (JSON.stringify(fields).length > 20_000) throw new Error('Lark record is too large');
    return { path: basePath, method: 'POST', body: { fields } };
  }
  const record = tokenPart.parse(operation.recordId);
  if (operation.action === 'base.delete') {
    return { path: `${basePath}/${record}`, method: 'DELETE' };
  }
  const fields = fieldValues.parse(operation.fields);
  if (JSON.stringify(fields).length > 20_000) throw new Error('Lark record is too large');
  return {
    path: `${basePath}/${record}`,
    method: 'PUT',
    body: { fields },
  };
}

export function createLarkDataClient(configuration: {
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
}) {
  const request = configuration.fetch ?? fetch;
  let botToken: { value: string; expiresAt: number } | undefined;

  async function botAccessToken(): Promise<string> {
    if (botToken && botToken.expiresAt > Date.now() + 60_000) {
      return botToken.value;
    }
    const response = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: configuration.appId, app_secret: configuration.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Lark bot authorization failed');
    const parsed = tenantTokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new Error('Lark bot authorization failed');
    botToken = {
      value: parsed.data.tenant_access_token,
      expiresAt: Date.now() + parsed.data.expire * 1_000,
    };
    return botToken.value;
  }

  return {
    async execute(operation: LarkDataOperation, identity: 'bot' | { userAccessToken: string }): Promise<unknown> {
      const { path, method, body } = requestForLarkDataOperation(operation);
      const token = identity === 'bot' ? await botAccessToken() : identity.userAccessToken;
      const response = await request(`https://open.feishu.cn/open-apis${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Lark data request failed');
      const text = await response.text();
      if (text.length > 100_000) throw new Error('Lark data response is too large');
      const parsed = apiResponse.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.code !== 0) {
        throw new Error('Lark data operation was rejected');
      }
      return parsed.data.data ?? null;
    },
  };
}
