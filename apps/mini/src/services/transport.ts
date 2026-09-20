import { loadAuth, saveAuth, clearAuth, refreshAttemptId } from './vault';
import type { Tokens } from './types';
import { query } from './query';

export const API_BASE = (
  import.meta.env?.VITE_API_BASE_URL || 'https://pointjoy.jinjiazh.com/api/v1'
).replace(/\/$/, '');

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public status = 0,
    public requestId = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  data: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  requestId: string;
  serverTime: string;
}

let refreshPromise: Promise<void> | null = null;

export let serverOffset = 0;

async function transport<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const token = loadAuth()?.accessToken;
  const wireMethod = method === 'PATCH' ? 'POST' : method;
  const methodHeaders = method === 'PATCH' ? { 'X-HTTP-Method-Override': 'PATCH' } : {};
  return new Promise((resolve, reject) =>
    uni.request({
      url: API_BASE + path,
      method: wireMethod,
      data: body as UniApp.RequestOptions['data'],
      timeout: 20000,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...methodHeaders,
        ...headers,
      },
      success(res) {
        const envelope = res.data as Envelope<T>;
        if (envelope?.serverTime) {
          serverOffset = Date.parse(envelope.serverTime) - Date.now();
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && !envelope.error) {
          resolve(envelope.data);
          return;
        }
        const e = envelope?.error;
        reject(
          new ApiError(
            e?.code || 'HTTP_ERROR',
            e?.message || '暂时无法完成，请稍后重试',
            e?.details || {},
            res.statusCode,
            envelope?.requestId,
          ),
        );
      },
      fail() {
        reject(new ApiError('NETWORK_UNKNOWN', '网络结果尚未确认，请查询这次操作'));
      },
    }),
  );
}

async function refresh() {
  if (refreshPromise) {
    return refreshPromise;
  }
  const auth = loadAuth();
  if (!auth?.refreshToken) {
    throw new ApiError('SESSION_EXPIRED', '请重新微信登录', {}, 401);
  }
  refreshPromise = (async () => {
    try {
      const result = await transport<Tokens>('POST', '/auth/refresh', {
        refreshToken: auth.refreshToken,
        refreshAttemptId: refreshAttemptId(),
      });
      saveAuth(result);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearAuth();
      }
      throw e;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  retry = true,
): Promise<T> {
  try {
    return await transport<T>(method, path, body, headers);
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status === 401 &&
      retry &&
      (path === '/auth/session' || !path.startsWith('/auth/'))
    ) {
      await refresh();
      return request<T>(method, path, body, headers, false);
    }
    throw e;
  }
}

export async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const scope = loadAuth()?.session.actorScopeKey;
  const result = await request<T>('GET', path + query(params));
  if (path.startsWith('/families/') && scope !== loadAuth()?.session.actorScopeKey) {
    throw new ApiError('SCOPE_MISMATCH', '身份已切换，请重新加载当前页面');
  }
  return result;
}

export async function getAll<T>(path: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await get<{ items: T[]; nextCursor?: string | null; hasMore: boolean }>(path, {
      ...params,
      limit: 100,
      cursor,
    });
    items.push(...page.items);
    cursor = page.hasMore ? page.nextCursor || undefined : undefined;
  } while (cursor);
  return items;
}

export const authPost = <T>(path: string, body: unknown) =>
  request<T>('POST', path, body, {}, false);

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : '暂时无法完成，请重试';
}
