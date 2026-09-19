CREATE INDEX reconcile_open_scope ON reconcile_incidents(family_id,child_id) WHERE status='OPEN';

CREATE TABLE activity_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id),
  type text NOT NULL CHECK(type IN ('ROUTINE','CHALLENGE')),
  lifecycle text NOT NULL DEFAULT 'DRAFT' CHECK(lifecycle IN ('DRAFT','PUBLISHED','STOPPED')),
  display_description text NOT NULL DEFAULT '', stopped_at timestamptz, stop_reason text,
  creator_membership_id uuid NOT NULL, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), FOREIGN KEY(family_id,creator_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE TABLE activity_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, plan_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0), title text NOT NULL CHECK(char_length(title) BETWEEN 2 AND 40),
  description text NOT NULL DEFAULT '' CHECK(char_length(description)<=500),
  metric text NOT NULL CHECK(metric IN ('CHECK','COUNT','DURATION','DISTANCE')),
  target_value integer, unit text, award_points bigint NOT NULL CHECK(award_points BETWEEN 1 AND 1000),
  weekdays smallint[], starts_at timestamptz, ends_at timestamptz,
  active boolean NOT NULL DEFAULT true, effective_from timestamptz, effective_to timestamptz,
  published_at timestamptz, superseded_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), UNIQUE(plan_id,revision), FOREIGN KEY(family_id,plan_id) REFERENCES activity_plans(family_id,id),
  CHECK((metric='CHECK' AND target_value IS NULL AND unit IS NULL) OR
        (metric='COUNT' AND target_value BETWEEN 1 AND 100000 AND unit IN ('REP','ITEM')) OR
        (metric='DURATION' AND target_value BETWEEN 1 AND 1440 AND unit='MINUTE') OR
        (metric='DISTANCE' AND target_value BETWEEN 1 AND 1000000 AND unit='METER')),
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at),
  CHECK(effective_to IS NULL OR effective_from IS NOT NULL AND effective_to>=effective_from)
);
CREATE UNIQUE INDEX plan_version_effective_boundary ON activity_plan_versions(plan_id,effective_from)
  WHERE published_at IS NOT NULL AND superseded_at IS NULL;
CREATE INDEX plan_version_lookup ON activity_plan_versions(family_id,plan_id,effective_from DESC);
CREATE TABLE plan_version_children (
  family_id uuid NOT NULL, plan_version_id uuid NOT NULL, child_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(plan_version_id,child_id),
  FOREIGN KEY(family_id,plan_version_id) REFERENCES activity_plan_versions(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE INDEX plan_children_lookup ON plan_version_children(child_id,plan_version_id);
CREATE TABLE activity_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, plan_id uuid NOT NULL,
  plan_version_id uuid NOT NULL, child_id uuid NOT NULL, occurrence_key text NOT NULL,
  type text NOT NULL CHECK(type IN ('ROUTINE','CHALLENGE')), business_date date,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  title_snapshot text NOT NULL, description_snapshot text NOT NULL DEFAULT '',
  metric_snapshot text NOT NULL, target_value_snapshot integer, unit_snapshot text,
  award_points_snapshot bigint NOT NULL CHECK(award_points_snapshot BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','SUBMITTED','NEEDS_CHANGES','APPROVED','EXEMPTED','REVOKED')),
  supplement_until timestamptz, latest_submission_id uuid, award_ledger_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), UNIQUE(family_id,plan_id,child_id,occurrence_key),
  FOREIGN KEY(family_id,plan_id) REFERENCES activity_plans(family_id,id),
  FOREIGN KEY(family_id,plan_version_id) REFERENCES activity_plan_versions(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id), CHECK(ends_at>starts_at),
  CHECK((type='ROUTINE' AND business_date IS NOT NULL AND occurrence_key='D:'||business_date::text)
     OR (type='CHALLENGE' AND business_date IS NULL AND occurrence_key='C'))
);
CREATE INDEX occurrences_today ON activity_occurrences(family_id,child_id,business_date,status);
CREATE INDEX occurrences_pending ON activity_occurrences(family_id,status,updated_at DESC,id DESC);
CREATE INDEX occurrences_history ON activity_occurrences(family_id,child_id,starts_at DESC,id DESC);
CREATE TABLE completion_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, occurrence_id uuid NOT NULL UNIQUE,
  child_id uuid NOT NULL, checked boolean, actual_value integer CHECK(actual_value>=0),
  note text NOT NULL DEFAULT '' CHECK(char_length(note)<=200), media_ids uuid[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(family_id,occurrence_id) REFERENCES activity_occurrences(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id), CHECK(cardinality(media_ids)<=3)
);
CREATE TABLE completion_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, occurrence_id uuid NOT NULL,
  child_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0), checked boolean, actual_value integer,
  note text NOT NULL DEFAULT '' CHECK(char_length(note)<=200), submitted_by_user_id uuid REFERENCES users(id),
  actor_mode text NOT NULL, child_session_source text, completed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), UNIQUE(occurrence_id,sequence),
  FOREIGN KEY(family_id,occurrence_id) REFERENCES activity_occurrences(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE submission_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, child_id uuid NOT NULL,
  occurrence_id uuid NOT NULL, submission_id uuid NOT NULL, media_id uuid NOT NULL REFERENCES media_assets(id),
  sort_order smallint NOT NULL CHECK(sort_order BETWEEN 0 AND 2), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(submission_id,media_id), UNIQUE(submission_id,sort_order),
  FOREIGN KEY(family_id,submission_id) REFERENCES completion_submissions(family_id,id),
  FOREIGN KEY(family_id,occurrence_id) REFERENCES activity_occurrences(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE completion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, occurrence_id uuid NOT NULL,
  submission_id uuid, action text NOT NULL CHECK(action IN ('APPROVE','RETURN','DIRECT_COMPLETE','EXEMPT','REVOKE')),
  reason text, actual_value integer, operator_membership_id uuid, supplement_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(family_id,occurrence_id) REFERENCES activity_occurrences(family_id,id),
  FOREIGN KEY(family_id,submission_id) REFERENCES completion_submissions(family_id,id),
  FOREIGN KEY(family_id,operator_membership_id) REFERENCES guardian_memberships(family_id,id)
);
CREATE TABLE point_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, child_id uuid NOT NULL,
  available_points bigint NOT NULL DEFAULT 0 CHECK(available_points>=0), held_points bigint NOT NULL DEFAULT 0 CHECK(held_points>=0),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(family_id,child_id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE point_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, child_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('ACTIVITY_AWARD','PRAISE','AWARD_REVERSAL','ORDER_HOLD','ORDER_CAPTURE','ORDER_RELEASE','ORDER_REFUND')),
  available_delta bigint NOT NULL, held_delta bigint NOT NULL,
  available_after bigint NOT NULL CHECK(available_after>=0), held_after bigint NOT NULL CHECK(held_after>=0),
  account_version bigint NOT NULL CHECK(account_version>0), source_type text NOT NULL, source_id uuid NOT NULL,
  actor_user_id uuid REFERENCES users(id), actor_membership_id uuid, actor_mode text NOT NULL,
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 200), reversal_of_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(family_id,id),
  UNIQUE(family_id,child_id,account_version), UNIQUE(family_id,source_type,source_id,type), UNIQUE(reversal_of_id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id),
  FOREIGN KEY(family_id,actor_membership_id) REFERENCES guardian_memberships(family_id,id),
  FOREIGN KEY(family_id,reversal_of_id) REFERENCES point_ledger(family_id,id),
  CHECK(available_delta<>0 OR held_delta<>0),
  CHECK((type IN ('ACTIVITY_AWARD','PRAISE','ORDER_REFUND') AND available_delta>0 AND held_delta=0)
     OR (type='AWARD_REVERSAL' AND available_delta<0 AND held_delta=0 AND reversal_of_id IS NOT NULL)
     OR (type='ORDER_HOLD' AND available_delta<0 AND held_delta=-available_delta)
     OR (type='ORDER_CAPTURE' AND available_delta=0 AND held_delta<0)
     OR (type='ORDER_RELEASE' AND available_delta>0 AND held_delta=-available_delta))
);
CREATE INDEX ledger_history ON point_ledger(family_id,child_id,account_version DESC);
ALTER TABLE activity_occurrences ADD CONSTRAINT occurrence_submission_fk FOREIGN KEY(family_id,latest_submission_id) REFERENCES completion_submissions(family_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE activity_occurrences ADD CONSTRAINT occurrence_award_fk FOREIGN KEY(family_id,award_ledger_id) REFERENCES point_ledger(family_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES families(id),
  name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 40), description text NOT NULL DEFAULT '' CHECK(char_length(description)<=500),
  category text NOT NULL CHECK(category IN ('TIME','FOOD','ITEM','EXPERIENCE')),
  benefit_description text NOT NULL CHECK(char_length(benefit_description) BETWEEN 1 AND 200), time_minutes integer,
  art_key text NOT NULL DEFAULT 'gift', cost_points bigint NOT NULL CHECK(cost_points BETWEEN 1 AND 100000),
  stock_mode text NOT NULL CHECK(stock_mode IN ('FINITE','UNLIMITED')), stock_available bigint,
  stock_version bigint NOT NULL DEFAULT 0 CHECK(stock_version>=0), weekly_limit integer CHECK(weekly_limit BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  published_at timestamptz, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), CHECK((stock_mode='FINITE' AND stock_available BETWEEN 0 AND 1000000) OR (stock_mode='UNLIMITED' AND stock_available IS NULL)),
  CHECK((category='TIME' AND time_minutes BETWEEN 1 AND 1440) OR (category<>'TIME' AND time_minutes IS NULL))
);
CREATE INDEX reward_list ON rewards(family_id,status,created_at DESC,id DESC);
CREATE TABLE reward_children (
  family_id uuid NOT NULL, reward_id uuid NOT NULL, child_id uuid NOT NULL, PRIMARY KEY(reward_id,child_id),
  FOREIGN KEY(family_id,reward_id) REFERENCES rewards(family_id,id), FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE redemption_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, child_id uuid NOT NULL, reward_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK(status IN ('PENDING_APPROVAL','READY','FULFILLED','REJECTED','CANCELED','EXPIRED')),
  quantity smallint NOT NULL DEFAULT 1 CHECK(quantity=1), cost_points_snapshot bigint NOT NULL CHECK(cost_points_snapshot BETWEEN 1 AND 100000),
  reward_snapshot jsonb NOT NULL, applicant_mode text NOT NULL, applicant_user_id uuid REFERENCES users(id),
  request_week_start date NOT NULL, weekly_limit_snapshot integer, approval_expires_at timestamptz NOT NULL,
  approved_at timestamptz, approved_by_membership_id uuid, fulfilled_at timestamptz, fulfilled_by_membership_id uuid,
  canceled_at timestamptz, canceled_by_user_id uuid, decided_at timestamptz, decision_reason text,
  arrangement_note text, fulfillment_note text, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,id), FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id),
  FOREIGN KEY(family_id,reward_id) REFERENCES rewards(family_id,id),
  FOREIGN KEY(family_id,approved_by_membership_id) REFERENCES guardian_memberships(family_id,id),
  FOREIGN KEY(family_id,fulfilled_by_membership_id) REFERENCES guardian_memberships(family_id,id),
  CHECK(status NOT IN ('READY','FULFILLED') OR approved_at IS NOT NULL),
  CHECK(status<>'FULFILLED' OR fulfilled_at IS NOT NULL),
  CHECK(status<>'CANCELED' OR canceled_at IS NOT NULL)
);
CREATE INDEX orders_list ON redemption_orders(family_id,status,created_at DESC,id DESC);
CREATE INDEX orders_child ON redemption_orders(family_id,child_id,created_at DESC,id DESC);
CREATE INDEX orders_expiry ON redemption_orders(approval_expires_at,id) WHERE status='PENDING_APPROVAL';
CREATE INDEX orders_week ON redemption_orders(family_id,reward_id,child_id,request_week_start,status);
CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, reward_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('INITIAL','ADJUST','RESERVE','RESTORE')), delta bigint NOT NULL CHECK(delta<>0),
  stock_after bigint NOT NULL CHECK(stock_after BETWEEN 0 AND 1000000), stock_version bigint NOT NULL CHECK(stock_version>0),
  order_id uuid, actor_user_id uuid REFERENCES users(id), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(family_id,reward_id,stock_version),
  FOREIGN KEY(family_id,reward_id) REFERENCES rewards(family_id,id), FOREIGN KEY(family_id,order_id) REFERENCES redemption_orders(family_id,id),
  CHECK(type NOT IN ('RESERVE','RESTORE') OR order_id IS NOT NULL),
  CHECK(type<>'RESERVE' OR delta=-1), CHECK(type<>'RESTORE' OR delta=1)
);
CREATE UNIQUE INDEX stock_order_unique ON stock_ledger(order_id,type) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX stock_initial_unique ON stock_ledger(reward_id) WHERE type='INITIAL';
CREATE TABLE weekly_quotas (
  family_id uuid NOT NULL, reward_id uuid NOT NULL, child_id uuid NOT NULL, week_start date NOT NULL,
  occupied_count integer NOT NULL DEFAULT 0 CHECK(occupied_count>=0), version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(family_id,reward_id,child_id,week_start),
  FOREIGN KEY(family_id,reward_id) REFERENCES rewards(family_id,id), FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE wishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL, child_id uuid NOT NULL, reward_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0), selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(family_id,child_id), FOREIGN KEY(family_id,reward_id) REFERENCES rewards(family_id,id),
  FOREIGN KEY(family_id,child_id) REFERENCES child_profiles(family_id,id)
);
CREATE TABLE domain_reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('PASS','FAIL')), issues jsonb NOT NULL, counts jsonb NOT NULL
);
CREATE TABLE domain_job_runs (
  job_key text PRIMARY KEY, status text NOT NULL CHECK(status IN ('RUNNING','DONE','FAILED')),
  lease_until timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz
);
CREATE FUNCTION guard_domain_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('pointjoy.privacy_maintenance',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'immutable business fact; append a correction instead' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_ledger_immutable BEFORE UPDATE OR DELETE ON point_ledger FOR EACH ROW EXECUTE FUNCTION guard_domain_immutable();
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION guard_domain_immutable();
CREATE TRIGGER completion_decisions_immutable BEFORE UPDATE OR DELETE ON completion_decisions FOR EACH ROW EXECUTE FUNCTION guard_domain_immutable();
ALTER TABLE point_ledger ADD CONSTRAINT ledger_reversal_reference CHECK((type='AWARD_REVERSAL')=(reversal_of_id IS NOT NULL));
