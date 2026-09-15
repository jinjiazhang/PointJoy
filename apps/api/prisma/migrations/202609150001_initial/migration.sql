-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(40) NOT NULL,
    "avatar" TEXT NOT NULL DEFAULT 'blue',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200) NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT 'blue',
    "ownerMemberId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_accounts" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "point_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_ledger" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "accountVersion" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "actorMemberId" UUID NOT NULL,
    "orderId" UUID,
    "reversalOfId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "art" TEXT NOT NULL DEFAULT 'gift',
    "type" TEXT NOT NULL,
    "fulfillmentInstructions" VARCHAR(500) NOT NULL,
    "costPoints" INTEGER NOT NULL,
    "stockAvailable" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "stockVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "rewardId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "stockVersion" INTEGER NOT NULL,
    "actorMemberId" UUID NOT NULL,
    "orderId" UUID,
    "reason" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemptions" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "rewardId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "costPoints" INTEGER NOT NULL,
    "rewardSnapshot" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fulfilledAt" TIMESTAMPTZ,
    "fulfilledByMemberId" UUID,
    "fulfillmentNote" TEXT,
    "canceledAt" TIMESTAMPTZ,
    "canceledByMemberId" UUID,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "creatorMemberId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 100,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "join_applications" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "applicantUserId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionReason" TEXT,
    "decidedByMemberId" UUID,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "join_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "actorMemberId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "members_userId_idx" ON "members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "members_groupId_userId_key" ON "members"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "members_groupId_id_key" ON "members"("groupId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "point_accounts_groupId_memberId_key" ON "point_accounts"("groupId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_reversalOfId_key" ON "point_ledger"("reversalOfId");

-- CreateIndex
CREATE INDEX "point_ledger_groupId_memberId_createdAt_id_idx" ON "point_ledger"("groupId", "memberId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_groupId_id_key" ON "point_ledger"("groupId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_groupId_memberId_accountVersion_key" ON "point_ledger"("groupId", "memberId", "accountVersion");

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_orderId_type_key" ON "point_ledger"("orderId", "type");

-- CreateIndex
CREATE INDEX "rewards_groupId_status_createdAt_idx" ON "rewards"("groupId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rewards_groupId_id_key" ON "rewards"("groupId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_groupId_rewardId_stockVersion_key" ON "stock_ledger"("groupId", "rewardId", "stockVersion");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_orderId_type_key" ON "stock_ledger"("orderId", "type");

-- CreateIndex
CREATE INDEX "redemptions_groupId_memberId_createdAt_id_idx" ON "redemptions"("groupId", "memberId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "redemptions_groupId_status_createdAt_id_idx" ON "redemptions"("groupId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "redemptions_groupId_id_key" ON "redemptions"("groupId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_codeHash_key" ON "invitations"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_groupId_id_key" ON "invitations"("groupId", "id");

-- CreateIndex
CREATE INDEX "join_applications_groupId_status_idx" ON "join_applications"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_userId_scope_key_key" ON "idempotency_records"("userId", "scope", "key");

-- CreateIndex
CREATE INDEX "audit_logs_groupId_createdAt_idx" ON "audit_logs"("groupId", "createdAt" DESC);


-- Business constraints supplement the generated Prisma migration.
ALTER TABLE sessions ADD FOREIGN KEY ("userId") REFERENCES users(id);
ALTER TABLE members ADD FOREIGN KEY ("groupId") REFERENCES groups(id);
ALTER TABLE members ADD FOREIGN KEY ("userId") REFERENCES users(id);
ALTER TABLE groups ADD CONSTRAINT owner_in_group FOREIGN KEY(id,"ownerMemberId") REFERENCES members("groupId",id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE members ADD CHECK (role IN ('ADMIN','MEMBER'));
ALTER TABLE point_accounts ADD FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id);
ALTER TABLE point_accounts ADD CHECK(balance BETWEEN 0 AND 2000000000 AND version>=0);
ALTER TABLE rewards ADD FOREIGN KEY("groupId") REFERENCES groups(id);
ALTER TABLE rewards ADD CHECK("costPoints" BETWEEN 1 AND 2000000000 AND "stockAvailable" BETWEEN 0 AND 2000000000);
ALTER TABLE rewards ADD CHECK(type IN ('VIRTUAL','PHYSICAL') AND status IN ('DRAFT','ACTIVE','INACTIVE'));
ALTER TABLE redemptions ADD FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id);
ALTER TABLE redemptions ADD FOREIGN KEY("groupId","rewardId") REFERENCES rewards("groupId",id);
ALTER TABLE redemptions ADD FOREIGN KEY("groupId","fulfilledByMemberId") REFERENCES members("groupId",id);
ALTER TABLE redemptions ADD FOREIGN KEY("groupId","canceledByMemberId") REFERENCES members("groupId",id);
ALTER TABLE redemptions ADD CHECK("costPoints">0);
ALTER TABLE redemptions ADD CHECK(
 (status='PENDING' AND "fulfilledAt" IS NULL AND "canceledAt" IS NULL AND "fulfilledByMemberId" IS NULL AND "canceledByMemberId" IS NULL)
 OR (status='FULFILLED' AND "fulfilledAt" IS NOT NULL AND "fulfilledByMemberId" IS NOT NULL AND "canceledAt" IS NULL AND "canceledByMemberId" IS NULL)
 OR (status='CANCELED' AND "canceledAt" IS NOT NULL AND "canceledByMemberId" IS NOT NULL AND "cancelReason" IS NOT NULL AND "fulfilledAt" IS NULL AND "fulfilledByMemberId" IS NULL)
);
ALTER TABLE point_ledger ADD FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id);
ALTER TABLE point_ledger ADD FOREIGN KEY("groupId","actorMemberId") REFERENCES members("groupId",id);
ALTER TABLE point_ledger ADD FOREIGN KEY("groupId","orderId") REFERENCES redemptions("groupId",id);
ALTER TABLE point_ledger ADD FOREIGN KEY("groupId","reversalOfId") REFERENCES point_ledger("groupId",id);
ALTER TABLE point_ledger ADD CHECK(delta<>0 AND "balanceAfter" BETWEEN 0 AND 2000000000 AND "accountVersion">0);
ALTER TABLE point_ledger ADD CHECK(type IN ('GRANT','ADJUSTMENT','REDEEM','REFUND','REVERSAL'));
ALTER TABLE point_ledger ADD CHECK((type IN ('REDEEM','REFUND'))=("orderId" IS NOT NULL));
ALTER TABLE point_ledger ADD CHECK((type='REVERSAL')=("reversalOfId" IS NOT NULL));
ALTER TABLE point_ledger ADD CHECK((type NOT IN ('GRANT','REFUND') OR delta>0) AND (type<>'REDEEM' OR delta<0));
ALTER TABLE stock_ledger ADD FOREIGN KEY("groupId","rewardId") REFERENCES rewards("groupId",id);
ALTER TABLE stock_ledger ADD FOREIGN KEY("groupId","actorMemberId") REFERENCES members("groupId",id);
ALTER TABLE stock_ledger ADD FOREIGN KEY("groupId","orderId") REFERENCES redemptions("groupId",id);
ALTER TABLE stock_ledger ADD CHECK(delta<>0 AND "stockAfter" BETWEEN 0 AND 2000000000 AND "stockVersion">0);
ALTER TABLE stock_ledger ADD CHECK(type IN ('INITIAL','ADJUSTMENT','REDEEM','RESTORE'));
ALTER TABLE stock_ledger ADD CHECK((type IN ('REDEEM','RESTORE'))=("orderId" IS NOT NULL));
ALTER TABLE stock_ledger ADD CHECK((type<>'REDEEM' OR delta=-1) AND (type<>'RESTORE' OR delta=1));
CREATE UNIQUE INDEX one_initial_stock ON stock_ledger("rewardId") WHERE type='INITIAL';
ALTER TABLE invitations ADD FOREIGN KEY("groupId","creatorMemberId") REFERENCES members("groupId",id);
ALTER TABLE invitations ADD CHECK(uses BETWEEN 0 AND "maxUses" AND "maxUses" BETWEEN 1 AND 100);
ALTER TABLE join_applications ADD FOREIGN KEY("groupId","invitationId") REFERENCES invitations("groupId",id);
ALTER TABLE join_applications ADD FOREIGN KEY("applicantUserId") REFERENCES users(id);
ALTER TABLE join_applications ADD FOREIGN KEY("groupId","decidedByMemberId") REFERENCES members("groupId",id);
ALTER TABLE join_applications ADD CHECK(status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
CREATE UNIQUE INDEX one_pending_application ON join_applications("groupId","applicantUserId") WHERE status='PENDING';
ALTER TABLE idempotency_records ADD FOREIGN KEY("userId") REFERENCES users(id);
ALTER TABLE audit_logs ADD FOREIGN KEY("groupId","actorMemberId") REFERENCES members("groupId",id);
CREATE FUNCTION pointjoy_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only business ledger'; END $$;
CREATE TRIGGER protect_point_ledger BEFORE UPDATE OR DELETE ON point_ledger FOR EACH ROW EXECUTE FUNCTION pointjoy_append_only();
CREATE TRIGGER protect_stock_ledger BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION pointjoy_append_only();
CREATE TRIGGER protect_audit_logs BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION pointjoy_append_only();
