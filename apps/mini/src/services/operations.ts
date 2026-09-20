import { loadAuth, uuid } from './vault';
import { ApiError, get, request, type HttpMethod } from './transport';

export interface PendingOperation {
  key: string;
  scope: string;
  method: HttpMethod;
  path: string;
  body: unknown;
  label: string;
  createdAt: string;
  state: 'SENDING' | 'UNKNOWN';
  requestId?: string;
}

const PENDING = 'pointjoy.operations.v1';

const inflight = new Map<string, Promise<unknown>>();

export function pendingOperations(): PendingOperation[] {
  try {
    return uni.getStorageSync(PENDING) || [];
  } catch {
    return [];
  }
}

function persist(items: PendingOperation[]) {
  uni.setStorageSync(PENDING, items);
  uni.$emit('operations:changed');
}

function scopeFor(path: string) {
  const s = loadAuth()?.session;
  return path === '/me/profile' ? s?.accountScopeKey : s?.actorScopeKey;
}

export function currentPending() {
  const s = loadAuth()?.session;
  return pendingOperations().filter(
    (o) =>
      o.scope === s?.actorScopeKey || (o.path === '/me/profile' && o.scope === s?.accountScopeKey),
  );
}

export async function mutate<T>(
  method: HttpMethod,
  path: string,
  body: unknown = {},
  label = '保存修改',
): Promise<T> {
  const scope = scopeFor(path);
  if (!scope) {
    throw new ApiError('SESSION_EXPIRED', '请重新登录后继续');
  }
  const existing = pendingOperations().find(
    (o) => o.scope === scope && o.method === method && o.path === path,
  );
  if (existing) {
    if (inflight.has(existing.key) && JSON.stringify(existing.body) === JSON.stringify(body)) {
      return inflight.get(existing.key) as Promise<T>;
    }
    throw new ApiError('OPERATION_IN_PROGRESS', '这次操作尚未确认，请先查询原操作', {
      operationKey: existing.key,
    });
  }
  const op: PendingOperation = {
    key: uuid(),
    scope,
    method,
    path,
    body,
    label,
    createdAt: new Date().toISOString(),
    state: 'SENDING',
  };
  persist([...pendingOperations(), op]);
  return sendOperation<T>(op);
}

async function sendOperation<T>(op: PendingOperation): Promise<T> {
  const promise = (async () => {
    try {
      const result = await request<T>(op.method, op.path, op.body, { 'Idempotency-Key': op.key });
      persist(pendingOperations().filter((o) => o.key !== op.key));
      return result;
    } catch (e) {
      const error = e as ApiError;
      const unknown =
        error.status >= 500 ||
        error.code === 'NETWORK_UNKNOWN' ||
        error.code === 'OPERATION_IN_PROGRESS';
      if (unknown) {
        persist(
          pendingOperations().map((o) =>
            o.key === op.key ? { ...o, state: 'UNKNOWN', requestId: error.requestId } : o,
          ),
        );
        throw new ApiError(
          'OPERATION_IN_PROGRESS',
          '结果尚未确认，请查询原操作',
          { operationKey: op.key },
          error.status,
          error.requestId,
        );
      }
      persist(pendingOperations().filter((o) => o.key !== op.key));
      throw e;
    } finally {
      inflight.delete(op.key);
    }
  })();
  inflight.set(op.key, promise);
  return promise;
}

export async function recoverOperation(op: PendingOperation) {
  if (scopeFor(op.path) !== op.scope) {
    throw new ApiError('SCOPE_MISMATCH', '请回到发起操作的原身份继续确认');
  }
  const result = await get<{ state: string; result?: unknown; retryWithSameKey?: boolean }>(
    `/operations/${op.key}`,
    { method: op.method, path: op.path },
  );
  if (result.state === 'SUCCEEDED') {
    persist(pendingOperations().filter((o) => o.key !== op.key));
    return result.result;
  }
  if (result.state === 'NOT_OBSERVED' && result.retryWithSameKey) {
    return sendOperation(op);
  }
  throw new ApiError('OPERATION_IN_PROGRESS', '服务器仍在确认，请稍后查询原操作');
}
