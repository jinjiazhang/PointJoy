ALTER TABLE outbox ALTER COLUMN created_at SET DEFAULT clock_timestamp();
-- Recovery protection deliberately lives outside database backups. Each committed
-- authority transition is journaled before an HTTP success can be acknowledged.
CREATE FUNCTION pointjoy_security_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb; old_v jsonb; event_id uuid;
BEGIN
  IF current_setting('pointjoy.recovery_replay',true)='on' THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  v := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_v := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  IF TG_TABLE_NAME='users' THEN
    v := jsonb_build_object('id',v->'id','status',v->'status','security_version',v->'security_version');
    IF TG_OP='UPDATE' AND OLD.status=NEW.status AND OLD.security_version=NEW.security_version THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='families' THEN
    v := jsonb_build_object('id',v->'id','status',v->'status','owner_membership_id',v->'owner_membership_id','version',v->'version');
    IF TG_OP='UPDATE' AND OLD.status=NEW.status AND OLD.owner_membership_id IS NOT DISTINCT FROM NEW.owner_membership_id THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='guardian_memberships' THEN
    v := jsonb_build_object('id',v->'id','family_id',v->'family_id','user_id',v->'user_id','status',v->'status','version',v->'version');
    IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='child_profiles' THEN
    v := jsonb_build_object('id',v->'id','family_id',v->'family_id','bound_user_id',v->'bound_user_id','binding_version',v->'binding_version','status',v->'status','version',v->'version');
    IF TG_OP='UPDATE' AND OLD.status=NEW.status AND OLD.binding_version=NEW.binding_version AND OLD.bound_user_id IS NOT DISTINCT FROM NEW.bound_user_id THEN RETURN NEW; END IF;
  END IF;
  event_id:=gen_random_uuid();
  INSERT INTO outbox(id,event_key,event_type,payload) VALUES(event_id,'security:'||event_id,'SECURITY_PROTECTION',jsonb_build_object('kind','ROW_CHANGE','table',TG_TABLE_NAME,'operation',TG_OP,'row',v));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_security AFTER UPDATE OF status,security_version OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION pointjoy_security_change();
CREATE TRIGGER families_security AFTER INSERT OR UPDATE OF status,owner_membership_id OR DELETE ON families FOR EACH ROW EXECUTE FUNCTION pointjoy_security_change();
CREATE TRIGGER guardians_security AFTER INSERT OR UPDATE OF status OR DELETE ON guardian_memberships FOR EACH ROW EXECUTE FUNCTION pointjoy_security_change();
CREATE TRIGGER children_security AFTER INSERT OR UPDATE OF status,bound_user_id,binding_version OR DELETE ON child_profiles FOR EACH ROW EXECUTE FUNCTION pointjoy_security_change();
CREATE TRIGGER principals_security AFTER INSERT OR UPDATE OR DELETE ON family_principals FOR EACH ROW EXECUTE FUNCTION pointjoy_security_change();
