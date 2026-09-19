CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL DEFAULT '', avatar_media_id uuid,
 profile_completed_at timestamptz, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 security_version bigint NOT NULL DEFAULT 1, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(char_length(display_name)<=24), CHECK(profile_completed_at IS NULL OR (avatar_media_id IS NOT NULL AND char_length(btrim(display_name))>0))
);
CREATE TABLE auth_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL DEFAULT 'WECHAT',
 app_id text NOT NULL, subject text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,app_id,subject)
);
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 mode text NOT NULL CHECK(mode IN ('PROFILE_ONLY','LOCKED','ACCOUNT','GUARDIAN','CHILD')),
 child_session_source text CHECK(child_session_source IN ('DIRECT','DELEGATED')), family_id uuid, child_id uuid, source_membership_id uuid,
 binding_version bigint, security_version bigint NOT NULL, access_hash text UNIQUE NOT NULL, refresh_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL, pin_verified_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((mode='CHILD' AND child_session_source IS NOT NULL AND family_id IS NOT NULL AND child_id IS NOT NULL) OR (mode<>'CHILD' AND child_session_source IS NULL)),
 CHECK(child_session_source IS DISTINCT FROM 'DELEGATED' OR source_membership_id IS NOT NULL),
 CHECK(child_session_source IS DISTINCT FROM 'DIRECT' OR binding_version IS NOT NULL)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_child_idx ON auth_sessions(family_id,child_id) WHERE mode='CHILD';
CREATE TABLE pin_credentials (
 user_id uuid PRIMARY KEY REFERENCES users(id), pin_hash text, recovery_hash text,
 pending_pin_hash text, pending_recovery_hash text, enrollment_id uuid, enrollment_expires_at timestamptz,
 recovery_blocked boolean NOT NULL DEFAULT false, failure_count integer NOT NULL DEFAULT 0, locked_until timestamptz, credential_version bigint NOT NULL DEFAULT 1,
 enabled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, attempt_id uuid NOT NULL, credential_hash text NOT NULL,
 response_ciphertext text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,attempt_id,credential_hash)
);
CREATE TABLE auth_rate_limits (
 key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, blocked_until timestamptz
);
CREATE TABLE consent_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), policy_version text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(), scope text NOT NULL DEFAULT 'ACCOUNT', UNIQUE(user_id,policy_version,scope)
);
CREATE TABLE families (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 2 AND 30),
 owner_membership_id uuid NOT NULL, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED','DELETING')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE TABLE guardian_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REMOVED')), version bigint NOT NULL DEFAULT 1,
 joined_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, UNIQUE(family_id,user_id), UNIQUE(family_id,id)
);
ALTER TABLE families ADD CONSTRAINT family_owner_same_family FOREIGN KEY(id,owner_membership_id) REFERENCES guardian_memberships(family_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX memberships_user_idx ON guardian_memberships(user_id,status);
CREATE TABLE child_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), creator_user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL DEFAULT(now()+interval '24 hours'), consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id)
);
CREATE TABLE media_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uploader_user_id uuid NOT NULL REFERENCES users(id), family_id uuid REFERENCES families(id),
 child_id uuid, child_draft_id uuid REFERENCES child_drafts(id), occurrence_id uuid,
 purpose text NOT NULL CHECK(purpose IN ('USER_AVATAR','CHILD_AVATAR','COMPLETION_EVIDENCE')),
 status text NOT NULL DEFAULT 'UPLOADING' CHECK(status IN ('UPLOADING','PROCESSING','READY','FAILED','DELETING','DELETED')),
 object_key text, original_object_key text, original_size bigint NOT NULL DEFAULT 0, mime text NOT NULL,
 width integer, height integer, crop jsonb, source_media_id uuid REFERENCES media_assets(id),
 upload_hash text, upload_session_id uuid REFERENCES auth_sessions(id), upload_expires_at timestamptz, uploaded_at timestamptz, ready_at timestamptz,
 first_submitted_at timestamptz, retention_until timestamptz, failure_code text,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(family_id,id), CHECK(original_size BETWEEN 0 AND 10485760),
 CHECK(purpose='USER_AVATAR' OR family_id IS NOT NULL),
 CHECK(purpose<>'COMPLETION_EVIDENCE' OR (child_id IS NOT NULL AND occurrence_id IS NOT NULL))
);
CREATE TABLE child_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id),
 nickname text NOT NULL CHECK(char_length(btrim(nickname)) BETWEEN 1 AND 24), avatar_media_id uuid NOT NULL REFERENCES media_assets(id),
 age_band text CHECK(age_band IN ('UNDER_4','AGE_4_6','AGE_7_9','AGE_10_12','OVER_12')), bound_user_id uuid REFERENCES users(id),
 binding_version bigint NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 UNIQUE(family_id,id)
);
CREATE UNIQUE INDEX child_bound_user_family ON child_profiles(family_id,bound_user_id) WHERE bound_user_id IS NOT NULL;
ALTER TABLE users ADD CONSTRAINT user_avatar_ref FOREIGN KEY(avatar_media_id) REFERENCES media_assets(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE media_assets ADD CONSTRAINT media_child_same_family FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX media_cleanup_idx ON media_assets(status,retention_until,created_at);
CREATE TABLE family_principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('GUARDIAN','CHILD')), membership_id uuid, child_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,user_id), UNIQUE(family_id,id),
 FOREIGN KEY(family_id,membership_id) REFERENCES guardian_memberships(family_id,id),
 FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id),
 CHECK((kind='GUARDIAN' AND membership_id IS NOT NULL AND child_id IS NULL) OR (kind='CHILD' AND child_id IS NOT NULL AND membership_id IS NULL))
);
CREATE TABLE invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), creator_membership_id uuid NOT NULL,
 purpose text NOT NULL DEFAULT 'GUARDIAN_JOIN' CHECK(purpose='GUARDIAN_JOIN'), token_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, consumed_at timestamptz, consumed_by_application_id uuid,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id),
 FOREIGN KEY(family_id,creator_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE TABLE join_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), invitation_id uuid NOT NULL REFERENCES invitations(id),
 applicant_user_id uuid NOT NULL REFERENCES users(id), applicant_profile_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN','EXPIRED')),
 reason text, decided_by_membership_id uuid, decided_at timestamptz,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id),
 FOREIGN KEY(family_id,decided_by_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE UNIQUE INDEX pending_guardian_application ON join_applications(family_id,applicant_user_id) WHERE status='PENDING';
CREATE TABLE child_binding_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), child_id uuid NOT NULL,
 creator_membership_id uuid NOT NULL, purpose text NOT NULL DEFAULT 'CHILD_BIND' CHECK(purpose='CHILD_BIND'),
 token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, consumed_at timestamptz,
 consumed_by_application_id uuid, version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id),
 FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id), FOREIGN KEY(family_id,creator_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE TABLE child_binding_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id), child_id uuid NOT NULL,
 invitation_id uuid NOT NULL REFERENCES child_binding_invitations(id), applicant_user_id uuid NOT NULL REFERENCES users(id), applicant_profile_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN','EXPIRED')),
 sync_profile boolean NOT NULL DEFAULT false, reason text, decided_by_membership_id uuid, decided_at timestamptz,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id),
 FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id), FOREIGN KEY(family_id,decided_by_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE UNIQUE INDEX pending_child_application ON child_binding_applications(family_id,applicant_user_id) WHERE status='PENDING';
CREATE TABLE media_read_grants (
 token_hash text PRIMARY KEY, media_id uuid NOT NULL REFERENCES media_assets(id), session_id uuid NOT NULL REFERENCES auth_sessions(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE step_up_grants (
 token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES auth_sessions(id), action text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_jobs (
 media_id uuid PRIMARY KEY REFERENCES media_assets(id), status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE privacy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), family_id uuid REFERENCES families(id),
 type text NOT NULL CHECK(type IN ('EXPORT','DELETE','PIN_RECOVERY')), scope text NOT NULL CHECK(scope IN ('SELF_ACCOUNT','FAMILY','PIN_SUPPORT')),
 status text NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','VERIFYING','PROCESSING','COMPLETED','NEEDS_ACTION','REJECTED','FAILED_RETRYABLE')),
 receipt_token_hash text UNIQUE, confirmation jsonb, user_visible_note text, support_contact text, outcome_code text, assigned_at timestamptz, completed_at timestamptz,
 due_at timestamptz NOT NULL, export_object_key text, export_expires_at timestamptz, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1, requested_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_queue_idx ON privacy_requests(status,requested_at);
CREATE TABLE export_read_grants (
 token_hash text PRIMARY KEY, request_id uuid NOT NULL REFERENCES privacy_requests(id), session_id uuid NOT NULL REFERENCES auth_sessions(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deletion_tombstones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid, family_id_hash text, subject_hash text,
 deleted_at timestamptz NOT NULL DEFAULT now(), backup_purge_due_at timestamptz NOT NULL,
 clear_after timestamptz NOT NULL, completed_at timestamptz
);
