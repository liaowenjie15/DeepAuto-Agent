import { z } from 'zod';

const tokenResponseSchema = z.object({
  code: z.union([z.literal(0), z.literal('0')]).optional(),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});

const userInfoResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    open_id: z.string().trim().min(1),
    tenant_key: z.string().trim().min(1),
  }),
});

export type LarkOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  scopes: string[];
};

export function createLarkOAuthProvider(configuration: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}) {
  const request = configuration.fetch ?? fetch;

  async function tokenRequest(
    input: Record<string, string>,
  ): Promise<LarkOAuthTokens> {
    let response: Response;
    try {
      response = await request('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          ...input,
          client_id: configuration.appId,
          client_secret: configuration.appSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Lark OAuth token endpoint is unavailable');
    }
    if (!response.ok) throw new Error('Lark OAuth token request failed');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Lark OAuth token response is invalid');
    }
    const parsed = tokenResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Lark OAuth token request failed');
    const now = Date.now();
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      accessExpiresAt: new Date(now + parsed.data.expires_in * 1_000),
      refreshExpiresAt: new Date(
        now + parsed.data.refresh_token_expires_in * 1_000,
      ),
      scopes: parsed.data.scope.split(/\s+/).filter(Boolean),
    };
  }

  return {
    authorizationUrl(state: string, scopes: readonly string[]): string {
      const url = new URL(
        'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      );
      url.searchParams.set('client_id', configuration.appId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', configuration.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', [...new Set(scopes)].join(' '));
      return url.toString();
    },
    exchangeCode(code: string): Promise<LarkOAuthTokens> {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: configuration.redirectUri,
      });
    },
    refresh(refreshToken: string): Promise<LarkOAuthTokens> {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },
    async getIdentity(accessToken: string) {
      let response: Response;
      try {
        response = await request(
          'https://open.feishu.cn/open-apis/authen/v1/user_info',
          {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        throw new Error('Lark OAuth identity endpoint is unavailable');
      }
      if (!response.ok) throw new Error('Lark OAuth identity request failed');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Lark OAuth identity response is invalid');
      }
      const parsed = userInfoResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error('Lark OAuth identity request failed');
      return {
        openId: parsed.data.data.open_id,
        tenantKey: parsed.data.data.tenant_key,
      };
    },
  };
}
