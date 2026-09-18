DROP TABLE activity_claims;
DROP TABLE activities;
CREATE TABLE daily_routines (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL REFERENCES groups(id), title varchar(60) NOT NULL, description varchar(2000) NOT NULL,
 points integer NOT NULL CHECK(points>0 AND points<=2000000000), status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 "creatorMemberId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "closedAt" timestamptz,

 UNIQUE("groupId",id), FOREIGN KEY("groupId","creatorMemberId") REFERENCES members("groupId",id)
);
CREATE TABLE events (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL REFERENCES groups(id), title varchar(60) NOT NULL, description varchar(2000) NOT NULL,
 points integer NOT NULL CHECK(points>0 AND points<=2000000000), status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 "creatorMemberId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "closedAt" timestamptz,
 "startsAt" timestamptz NOT NULL, "endsAt" timestamptz NOT NULL, CHECK("endsAt">"startsAt"),
 UNIQUE("groupId",id), FOREIGN KEY("groupId","creatorMemberId") REFERENCES members("groupId",id)
);
CREATE TABLE daily_entries (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "routineId" uuid NOT NULL, "memberId" uuid NOT NULL,
 "occurrenceDate" date NOT NULL,
 "awardPoints" integer NOT NULL CHECK("awardPoints">0 AND "awardPoints"<=2000000000),
 status text NOT NULL DEFAULT 'CLAIMED' CHECK(status IN ('CLAIMED','SUBMITTED','REJECTED','APPROVED')),
 submission varchar(1000) NOT NULL DEFAULT '', "reviewReason" varchar(200) NOT NULL DEFAULT '',
 "reviewerMemberId" uuid, "ledgerId" uuid UNIQUE, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 "expiresAt" timestamptz NOT NULL, "submittedAt" timestamptz, "reviewedAt" timestamptz,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL,
 UNIQUE("routineId","memberId","occurrenceDate"),
 FOREIGN KEY("groupId","routineId") REFERENCES daily_routines("groupId",id),
 FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","reviewerMemberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","ledgerId") REFERENCES point_ledger("groupId",id),
 CHECK((status='APPROVED')=("ledgerId" IS NOT NULL))
);
CREATE INDEX daily_entries_review ON daily_entries("groupId",status);
CREATE INDEX daily_entries_history ON daily_entries("groupId","memberId","createdAt" DESC,id DESC);
CREATE TABLE event_entries (
 id uuid PRIMARY KEY, "groupId" uuid NOT NULL, "eventId" uuid NOT NULL, "memberId" uuid NOT NULL,

 "awardPoints" integer NOT NULL CHECK("awardPoints">0 AND "awardPoints"<=2000000000),
 status text NOT NULL DEFAULT 'CLAIMED' CHECK(status IN ('CLAIMED','SUBMITTED','REJECTED','APPROVED')),
 submission varchar(1000) NOT NULL DEFAULT '', "reviewReason" varchar(200) NOT NULL DEFAULT '',
 "reviewerMemberId" uuid, "ledgerId" uuid UNIQUE, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 "expiresAt" timestamptz NOT NULL, "submittedAt" timestamptz, "reviewedAt" timestamptz,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL,
 UNIQUE("eventId","memberId"),
 FOREIGN KEY("groupId","eventId") REFERENCES events("groupId",id),
 FOREIGN KEY("groupId","memberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","reviewerMemberId") REFERENCES members("groupId",id),
 FOREIGN KEY("groupId","ledgerId") REFERENCES point_ledger("groupId",id),
 CHECK((status='APPROVED')=("ledgerId" IS NOT NULL))
);
CREATE INDEX event_entries_review ON event_entries("groupId",status);
CREATE INDEX event_entries_history ON event_entries("groupId","memberId","createdAt" DESC,id DESC);
