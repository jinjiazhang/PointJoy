import type pg from 'pg';
import type { FastifyRequest } from 'fastify';

export type Db = pg.PoolClient;

export type Queryable = Pick<pg.Pool, 'query'> | Pick<Db, 'query'>;

export type Mode = 'PROFILE_ONLY' | 'LOCKED' | 'ACCOUNT' | 'GUARDIAN' | 'CHILD';

export interface Actor {
  userId: string;
  sessionId: string;
  mode: Mode;
  childSessionSource?: 'DIRECT' | 'DELEGATED' | null;
  familyId?: string | null;
  childId?: string | null;
  securityVersion: number;
  membershipId?: string | null;
  role?: string | null;
  bindingVersion?: number | null;
  sourceSessionId?: string | null;
  pinVerifiedAt?: string | null;
  actorScopeKey?: string;
  accountScopeKey?: string;
  [key: string]: any;
}

export interface Requirements {
  familyId?: string;
  childId?: string;
  guardian?: boolean;
  owner?: boolean;
  profile?: boolean;
  write?: boolean;
  allowArchived?: boolean;
  [key: string]: any;
}

export interface MutationOptions extends Requirements {
  exclusiveFamily?: boolean;
  exclusiveUser?: boolean;
  extraUserIds?: string[];
  scope?: string;
  status?: number;
  protectionBarrier?: string;
}

export interface Config {
  appEnv: string;
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  apiBaseUrl: string;
  wechatAppId: string;
  wechatAppSecret: string;
  sessionSigningKey: string;
  responseEncryptionKey: string;
  mediaDir: string;
  exportDir: string;
  securityJournalDir: string;
  securityJournalKey: string;
  businessTimezone: string;
  supportContact: string;
  privacyVersion: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  [key: string]: any;
}

export interface Services {
  pool: pg.Pool;
  config: Config;
  auth: any;
  media: any;
  domain?: any;
  privacy?: any;
  mutate: (
    request: FastifyRequest,
    options: MutationOptions,
    fn: (db: Db, actor: Actor) => Promise<any>,
  ) => Promise<any>;
  flushProtection?: (barrier: string) => Promise<boolean>;
  [key: string]: any;
}
