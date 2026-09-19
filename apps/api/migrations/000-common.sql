CREATE TABLE operation_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_scope text NOT NULL,method text NOT NULL,path text NOT NULL,key uuid NOT NULL,request_hash text NOT NULL,status_code integer NOT NULL,response jsonb NOT NULL,protection_barrier text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_scope,method,path,key)
);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),family_id uuid,child_id uuid,actor_user_id uuid,actor_mode text NOT NULL,action text NOT NULL,source_id uuid,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_family_date ON audit_logs(family_id,created_at DESC,id DESC);
CREATE TABLE outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_key text NOT NULL UNIQUE,event_type text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready ON outbox(status,available_at);
CREATE TABLE reconcile_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),family_id uuid,child_id uuid,code text NOT NULL,details jsonb NOT NULL,status text NOT NULL DEFAULT 'OPEN',created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz
);
