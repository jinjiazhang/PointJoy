DROP TABLE task_claims;
DROP TABLE tasks;
CREATE TABLE activities (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL REFERENCES groups(id),
 kind text NOT NULL CHECK(kind IN ('DAILY','LIMITED')),
 "startsAt" timestamptz, "endsAt" timestamptz,
 CHECK((kind='DAILY' AND "startsAt" IS NULL AND "endsAt" IS NULL) OR (kind='LIMITED' AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "endsAt">"startsAt")),
 title varchar(60) NOT NULL, description varchar(2000) NOT NULL,
 points integer NOT NULL CHECK (points > 0 AND points <= 2000000000),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 "creatorMemberId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("groupId",id), FOREIGN KEY("groupId","creatorMemberId") REFERENCES members("groupId",id)
);
CREATE TABLE activity_claims (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "activityId" uuid NOT NULL, "memberId" uuid NOT NULL,
 status text NOT NULL DEFAULT 'CLAIMED' CHECK(status IN ('CLAIMED','SUBMITTED','REJECTED','APPROVED')),
 period varchar(10) NOT NULL, "expiresAt" timestamptz NOT NULL,
 submission varchar(1000) NOT NULL DEFAULT '', "reviewReason" varchar(200) NOT NULL DEFAULT '',
 "reviewerMemberId" uuid, "ledgerId" uuid UNIQUE,
 version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL,
 UNIQUE("activityId","memberId",period),
 FOREIGN KEY("groupId","activityId") REFERENCES activities("groupId",id),
 FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","reviewerMemberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","ledgerId") REFERENCES point_ledger("groupId",id),
 CHECK ((status='APPROVED') = ("ledgerId" IS NOT NULL))
);
CREATE INDEX activity_claims_group_status ON activity_claims("groupId",status);
