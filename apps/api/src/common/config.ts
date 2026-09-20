import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, type Config } from './index.js';
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultVar = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.var');
  const appEnv = env.APP_ENV || 'local';
  const production = appEnv === 'production';
  const secret = (key: string, fallback: string) => {
    const v = env[key];
    if (production && (!v || v.length < 24)) {
      throw new Error(`Required secret missing: ${key}`);
    }
    return v || fallback;
  };
  const required = (key: string, fallback: string) => {
    const v = env[key];
    if (production && !v) {
      throw new Error(`Required configuration missing: ${key}`);
    }
    return v || fallback;
  };
  if (!['local', 'test', 'staging', 'production'].includes(appEnv)) {
    throw new Error('Invalid APP_ENV');
  }
  const port = Number(env.PORT || 4100);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new AppError(500, 'CONFIG_ERROR', 'Invalid PORT');
  }
  return {
    appEnv,
    nodeEnv: env.NODE_ENV || 'development',
    port,
    host: env.HOST || '127.0.0.1',
    databaseUrl: required('DATABASE_URL', 'postgresql://localhost/pointjoy_rebuild_local'),
    apiBaseUrl: required('API_BASE_URL', `http://127.0.0.1:${port}/api/v1`),
    wechatAppId: required('WECHAT_APP_ID', 'wx-local'),
    wechatAppSecret: required('WECHAT_APP_SECRET', 'local-only'),
    sessionSigningKey: secret('SESSION_SIGNING_KEY', 'local-only-session-signing-key-32'),
    responseEncryptionKey: secret('RESPONSE_ENCRYPTION_KEY', 'local-only-response-encryption-key'),
    securityJournalKey: secret('SECURITY_JOURNAL_KEY', 'local-only-security-journal-key'),
    mediaDir: env.MEDIA_DIR ? path.resolve(env.MEDIA_DIR) : path.join(defaultVar, 'media'),
    exportDir: env.EXPORT_DIR ? path.resolve(env.EXPORT_DIR) : path.join(defaultVar, 'exports'),
    securityJournalDir: env.SECURITY_JOURNAL_DIR
      ? path.resolve(env.SECURITY_JOURNAL_DIR)
      : path.join(defaultVar, 'security'),
    businessTimezone: 'Asia/Shanghai',
    supportContact: required('SUPPORT_CONTACT', 'https://github.com/jinjiazhang/PointJoy/issues'),
    privacyVersion: '2026-09-19-v1',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
  };
}
