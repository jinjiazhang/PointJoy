import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, camel, rows, one, maybe, transaction, audit, randomUUID, z, type Db, type Services } from './index.js';
import { decryptJournal } from './security-journal.js';
import { deleteFamilyDomain, anonymizeSubjectDomain, reconcile } from '../domain/index.js';

type Event={id:string;createdAt:string;payload:any};
export interface RecoveryReport {
  runId:string;status:'READY'|'HOLD'|'FAILED';safeToStart:boolean;events:number;
  removedMemberships:string[];unboundChildren:string[];deletedFamilies:string[];deletedAccounts:string[];
  heldFamilies:{familyId:string;reason:string}[];blockedPinUsers:string[];
  pendingFiles:number;issues:{code:string;eventId?:string;subjectId?:string}[];reconciliationStatus?:string;
}
const uuid=z.string().uuid(),version=z.number().int().positive().safe();
const journalSchema=z.object({id:uuid,createdAt:z.string().datetime({offset:true}),payload:z.record(z.unknown())}).strict();
const manifestSchema=z.object({version:z.literal(1),sealedAt:z.string().datetime({offset:true}),entries:z.array(z.object({id:uuid,file:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function issue(code:string):Error&{code:string}{return Object.assign(new Error(code),{code});}
const hash=(body:Buffer)=>createHash('sha256').update(body).digest('hex');

export async function readVerifiedJournal(services:Services):Promise<Event[]>{
  const directory=services.config.securityJournalDir;
  let manifest:z.infer<typeof manifestSchema>;
  try{manifest=manifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8')));}catch{throw issue('JOURNAL_MANIFEST_INVALID');}
  const {signature,...unsigned}=manifest;
  const expected=createHmac('sha256',services.config.securityJournalKey).update(canonical(unsigned)).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw issue('JOURNAL_SIGNATURE_INVALID');
  const ids=new Set<string>(),events:Event[]=[];
  for(const item of manifest.entries){
    if(ids.has(item.id)||item.file!==`${item.id}.enc`)throw issue('JOURNAL_MANIFEST_INVALID');ids.add(item.id);
    let body:Buffer;try{body=await fs.readFile(path.join(directory,item.file));}catch{throw issue('JOURNAL_FILE_MISSING');}
    if(hash(body)!==item.sha256)throw issue('JOURNAL_FILE_CHANGED');
    try{const event=journalSchema.parse(decryptJournal(services.config.securityJournalKey,body));if(event.id!==item.id)throw new Error();events.push(event);}catch{throw issue('JOURNAL_EVENT_INVALID');}
  }
  // A pre-seal crash may leave an unreferenced .enc file. Refuse to guess whether
  // it belongs to an acknowledged transition; the journal custodian must fix it.
  for(const name of await fs.readdir(directory))if(name.endsWith('.enc')&&!ids.has(name.slice(0,-4)))throw issue('JOURNAL_UNSEALED_EVENT');
  for(const row of await rows<any>(services.pool,"SELECT id FROM outbox WHERE event_type='SECURITY_PROTECTION'"))if(!ids.has(row.id))throw issue('JOURNAL_DATABASE_EVENT_MISSING');
  return events.sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));
}

async function beginRecovery(db:Db){
  await db.query("SELECT set_config('pointjoy.recovery_replay','on',true)");
  await db.query('SELECT id FROM users ORDER BY id FOR UPDATE');
  await db.query('SELECT id FROM families ORDER BY id FOR UPDATE');
  await db.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()),pin_verified_at=NULL');
  await db.query('DELETE FROM auth_attempts');
  await db.query('UPDATE pin_credentials SET pending_pin_hash=NULL,pending_recovery_hash=NULL,enrollment_id=NULL,enrollment_expires_at=NULL');
  await db.query('DELETE FROM step_up_grants');
  await db.query('DELETE FROM media_read_grants');
  await db.query('DELETE FROM export_read_grants');
  // Restored bearer-style invitations must not undo a replayed withdrawal.
  await db.query('UPDATE invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp())');
  await db.query('UPDATE child_binding_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp())');
  await db.query("UPDATE join_applications SET status='EXPIRED' WHERE status='PENDING'");
  await db.query("UPDATE child_binding_applications SET status='EXPIRED' WHERE status='PENDING'");
}
async function blockPin(db:Db,userId:string,credentialVersion:number,at:string,report:RecoveryReport){
  if(!await maybe(db,'SELECT id FROM users WHERE id=$1',[userId]))return;
  await db.query(`INSERT INTO pin_credentials(user_id,enabled_at,credential_version,recovery_blocked)
    VALUES($1,$2,$3,true) ON CONFLICT(user_id) DO UPDATE SET
    enabled_at=COALESCE(pin_credentials.enabled_at,EXCLUDED.enabled_at),credential_version=GREATEST(pin_credentials.credential_version,EXCLUDED.credential_version),
    recovery_blocked=true,pin_hash=NULL,recovery_hash=NULL,pending_pin_hash=NULL,pending_recovery_hash=NULL,enrollment_id=NULL,enrollment_expires_at=NULL,updated_at=clock_timestamp()`,[userId,at,credentialVersion]);
  if(!report.blockedPinUsers.includes(userId))report.blockedPinUsers.push(userId);
}
async function holdFamily(db:Db,familyId:string,reason:string,report:RecoveryReport){
  await db.query("UPDATE families SET status='DELETING',updated_at=clock_timestamp() WHERE id=$1",[familyId]);
  if(!report.heldFamilies.some(x=>x.familyId===familyId&&x.reason===reason))report.heldFamilies.push({familyId,reason});
}
async function queueFile(db:Db,runId:string,storage:'MEDIA'|'EXPORT',key:unknown){
  if(typeof key==='string'&&key)await db.query('INSERT INTO recovery_file_cleanup(run_id,storage,object_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[runId,storage,key]);
}
async function queueMedia(db:Db,runId:string,assets:any[]){
  for(const asset of assets){await queueFile(db,runId,'MEDIA',asset.objectKey);await queueFile(db,runId,'MEDIA',asset.originalObjectKey);}
}
async function deleteRecoveredFamily(db:Db,familyId:string,report:RecoveryReport){
  if(!await maybe(db,'SELECT id FROM families WHERE id=$1',[familyId]))return;
  await queueMedia(db,report.runId,await rows(db,'SELECT * FROM media_assets WHERE family_id=$1',[familyId]));
  // Deliberately bypass backup-era owners/blockers: the independent journal is
  // evidence that deletion was already authorized and must not be resurrected.
  await deleteFamilyDomain(db,familyId);
  await db.query('DELETE FROM media_jobs WHERE media_id IN(SELECT id FROM media_assets WHERE family_id=$1)',[familyId]);
  for(const table of ['family_principals','child_binding_applications','child_binding_invitations','join_applications','invitations','child_profiles']as const)await db.query(`DELETE FROM ${table} WHERE family_id=$1`,[familyId]);
  await db.query('DELETE FROM media_assets WHERE family_id=$1',[familyId]);
  await db.query('DELETE FROM child_drafts WHERE family_id=$1',[familyId]);
  await db.query('DELETE FROM audit_logs WHERE family_id=$1',[familyId]);
  await db.query("UPDATE operation_records SET response=jsonb_build_object('redacted',true,'reason','FAMILY_DATA_DELETED') WHERE response::text LIKE $1",[`%${familyId}%`]);
  await db.query('DELETE FROM operation_records WHERE actor_scope LIKE $1 OR path LIKE $2',[`%:${familyId}:%`,`%/families/${familyId}%`]);
  await db.query("UPDATE privacy_requests SET family_id=NULL,export_object_key=NULL,export_expires_at=NULL,confirmation=NULL,status=CASE WHEN type='DELETE' THEN 'COMPLETED' ELSE status END WHERE family_id=$1",[familyId]);
  await db.query('DELETE FROM guardian_memberships WHERE family_id=$1',[familyId]);
  await db.query('DELETE FROM families WHERE id=$1',[familyId]);
  report.deletedFamilies.push(familyId);
}
async function deleteRecoveredAccount(db:Db,userId:string,childIds:string[],report:RecoveryReport){
  if(!await maybe(db,'SELECT id FROM users WHERE id=$1',[userId]))return;
  for(const f of await rows<any>(db,'SELECT f.id FROM families f JOIN guardian_memberships m ON m.id=f.owner_membership_id WHERE m.user_id=$1',[userId]))await holdFamily(db,f.id,'DELETED_ACCOUNT_WAS_BACKUP_OWNER',report);
  const children=await rows<any>(db,'SELECT * FROM child_profiles WHERE id=ANY($1::uuid[])',[childIds]);
  const assets=await rows<any>(db,`SELECT * FROM media_assets WHERE (purpose='USER_AVATAR' AND uploader_user_id=$1) OR child_id=ANY($2::uuid[]) OR id=ANY($3::uuid[])`,[userId,childIds,children.map(c=>c.avatarMediaId)]);
  await queueMedia(db,report.runId,assets);
  await anonymizeSubjectDomain(db,userId);
  for(const c of children){
    await db.query("UPDATE child_profiles SET nickname='已删除孩子资料',age_band=NULL,bound_user_id=NULL,binding_version=binding_version+1,version=version+1 WHERE id=$1",[c.id]);
    await db.query('DELETE FROM completion_drafts WHERE child_id=$1',[c.id]);
    await db.query("UPDATE completion_submissions SET note='' WHERE child_id=$1",[c.id]);
    await db.query('UPDATE completion_decisions SET reason=NULL WHERE occurrence_id IN(SELECT id FROM activity_occurrences WHERE child_id=$1)',[c.id]);
    await db.query("UPDATE point_ledger SET reason='已删除个人文本' WHERE child_id=$1",[c.id]);
    await db.query('UPDATE redemption_orders SET decision_reason=NULL,arrangement_note=NULL,fulfillment_note=NULL WHERE child_id=$1',[c.id]);
    await db.query("UPDATE audit_logs SET details='{}' WHERE child_id=$1",[c.id]);
    await db.query('DELETE FROM family_principals WHERE child_id=$1',[c.id]);
    // A parent's saved idempotency response can contain a child's old note or
    // avatar. Redact the response while retaining the key/hash: a replay must
    // neither disclose deleted data nor execute a second financial mutation.
    await db.query("UPDATE operation_records SET response=jsonb_build_object('redacted',true,'reason','SUBJECT_DATA_DELETED') WHERE response::text LIKE $1",[`%${c.id}%`]);
  }
  await db.query('DELETE FROM family_principals WHERE user_id=$1',[userId]);
  await db.query("UPDATE guardian_memberships SET status='REMOVED',removed_at=COALESCE(removed_at,clock_timestamp()),version=version+1 WHERE user_id=$1 AND status='ACTIVE'",[userId]);
  await db.query('DELETE FROM auth_identities WHERE user_id=$1',[userId]);
  await db.query('DELETE FROM pin_credentials WHERE user_id=$1',[userId]);
  await db.query('DELETE FROM consent_records WHERE user_id=$1',[userId]);
  await db.query("UPDATE users SET status='DISABLED',security_version=security_version+1,display_name='已删除账号',avatar_media_id=NULL,profile_completed_at=NULL,version=version+1 WHERE id=$1",[userId]);
  await db.query("UPDATE media_assets SET status='DELETED',object_key=NULL,original_object_key=NULL,upload_hash=NULL,source_media_id=NULL WHERE id=ANY($1::uuid[])",[assets.map(m=>m.id)]);
  await db.query("UPDATE audit_logs SET actor_user_id=NULL,details='{}' WHERE actor_user_id=$1",[userId]);
  for(const table of ['join_applications','child_binding_applications']as const)await db.query(`UPDATE ${table} SET applicant_profile_snapshot='{}',reason=NULL WHERE applicant_user_id=$1`,[userId]);
  await db.query("UPDATE operation_records SET response=jsonb_build_object('redacted',true,'reason','SUBJECT_DATA_DELETED') WHERE response::text LIKE $1",[`%${userId}%`]);
  await db.query('DELETE FROM operation_records WHERE actor_scope LIKE $1',[`${userId}:%`]);
  await db.query("UPDATE privacy_requests SET export_object_key=NULL,export_expires_at=NULL,confirmation=NULL,user_visible_note=NULL,status=CASE WHEN type='DELETE' THEN 'COMPLETED' ELSE status END WHERE user_id=$1",[userId]);
  report.deletedAccounts.push(userId);
}

async function removeMembership(db:Db,m:any,at:string,report:RecoveryReport){
  const current=await maybe<any>(db,'SELECT * FROM guardian_memberships WHERE id=$1',[m.id]);if(!current)return;
  if(m.version&&current.version>m.version)return;
  await db.query("UPDATE guardian_memberships SET status='REMOVED',removed_at=COALESCE(removed_at,$2),version=GREATEST(version,$3) WHERE id=$1",[m.id,at,m.version??current.version]);
  await db.query('DELETE FROM family_principals WHERE membership_id=$1',[m.id]);
  if(!report.removedMemberships.includes(m.id))report.removedMemberships.push(m.id);
}
async function unbind(db:Db,c:any,at:string,report:RecoveryReport){
  const current=await maybe<any>(db,'SELECT * FROM child_profiles WHERE id=$1',[c.id]);if(!current)return;
  if(c.bindingVersion&&current.bindingVersion>c.bindingVersion)return;
  await db.query('UPDATE child_profiles SET bound_user_id=NULL,binding_version=GREATEST(binding_version,$2),updated_at=$3 WHERE id=$1',[c.id,c.bindingVersion??current.bindingVersion,at]);
  await db.query('DELETE FROM family_principals WHERE child_id=$1',[c.id]);
  if(!report.unboundChildren.includes(c.id))report.unboundChildren.push(c.id);
}

async function replayRow(db:Db,event:Event,report:RecoveryReport){
  const p=event.payload,r=camel<any>(p.row),table=p.table;
  uuid.parse(r.id);const at=event.createdAt;
  if(table==='users'){
    await db.query("UPDATE users SET security_version=GREATEST(security_version,$2),status=CASE WHEN $3='DISABLED' OR $4='DELETE' THEN 'DISABLED' ELSE status END WHERE id=$1",[r.id,version.parse(r.securityVersion),r.status,p.operation]);return;
  }
  if(table==='families'){
    const f=await maybe<any>(db,'SELECT * FROM families WHERE id=$1',[r.id]);if(!f){if(p.operation!=='DELETE')await holdFamily(db,r.id,'FAMILY_NOT_IN_BACKUP',report);return;}
    if(p.operation==='DELETE')return; // Explicit deletion is collected before replay.
    if(f.version>r.version)return;
    if(r.ownerMembershipId!==f.ownerMembershipId){
      // Never promote an owner based on a partial recovery row.
      await holdFamily(db,r.id,'OWNER_CHANGED_AFTER_BACKUP',report);return;
    }
    if(r.status==='ARCHIVED')await db.query("UPDATE families SET status=CASE WHEN status='DELETING' THEN status ELSE 'ARCHIVED' END,archived_at=COALESCE(archived_at,$2),version=GREATEST(version,$3) WHERE id=$1",[r.id,at,r.version]);
    if(r.status==='DELETING')await holdFamily(db,r.id,'DELETION_OR_RECOVERY_IN_PROGRESS',report);
    return;
  }
  if(table==='guardian_memberships'){
    if(p.operation==='DELETE'||r.status==='REMOVED'){await removeMembership(db,r,at,report);return;}
    const current=await maybe<any>(db,'SELECT * FROM guardian_memberships WHERE id=$1',[r.id]);
    if(!current||current.userId!==r.userId||current.familyId!==r.familyId||(current.status!=='ACTIVE'&&current.version<=r.version))await holdFamily(db,r.familyId,'MEMBERSHIP_NOT_RECONSTRUCTABLE',report);
    return;
  }
  if(table==='child_profiles'){
    const c=await maybe<any>(db,'SELECT * FROM child_profiles WHERE id=$1',[r.id]);
    if(!c){if(p.operation!=='DELETE')await holdFamily(db,r.familyId,'CHILD_NOT_IN_BACKUP',report);return;}
    if(p.operation==='DELETE'){await holdFamily(db,r.familyId,'CHILD_DELETION_WITHOUT_COMPLETE_SCOPE',report);await unbind(db,r,at,report);return;}
    if(c.bindingVersion<=r.bindingVersion){
      if(!r.boundUserId)await unbind(db,r,at,report);
      else if(c.boundUserId!==r.boundUserId){await unbind(db,r,at,report);await holdFamily(db,r.familyId,'NEW_BINDING_NOT_RECONSTRUCTABLE',report);}
    }
    if(r.status==='ARCHIVED'&&c.version<=r.version)await db.query("UPDATE child_profiles SET status='ARCHIVED',archived_at=COALESCE(archived_at,$2),version=GREATEST(version,$3) WHERE id=$1",[r.id,at,r.version]);
    return;
  }
  if(table==='family_principals'){
    if(p.operation==='DELETE'){await db.query('DELETE FROM family_principals WHERE id=$1',[r.id]);return;}
    const existing=await maybe<any>(db,'SELECT * FROM family_principals WHERE id=$1',[r.id]);
    if(!existing||existing.userId!==r.userId||existing.kind!==r.kind||existing.membershipId!==r.membershipId||existing.childId!==r.childId)await holdFamily(db,r.familyId,'PRINCIPAL_NOT_RECONSTRUCTABLE',report);
    return;
  }
  throw issue('JOURNAL_UNKNOWN_ROW');
}

async function purgeQueuedFiles(services:Services){
  const tasks=await rows<any>(services.pool,"SELECT * FROM recovery_file_cleanup WHERE status='PENDING' ORDER BY id");
  for(const task of tasks){
    try{
      const root=path.resolve(task.storage==='MEDIA'?services.config.mediaDir:services.config.exportDir);
      if(!(task.storage==='MEDIA'?/^[a-z]+\/[a-zA-Z0-9.-]+$/:/^[a-zA-Z0-9-]+\.zip$/).test(task.objectKey))throw issue('UNSAFE_OBJECT_KEY');
      const target=path.resolve(root,task.objectKey);if(!target.startsWith(root+path.sep))throw issue('UNSAFE_OBJECT_KEY');
      // A still-authorized asset can share a normalized object (controlled avatar
      // derivation). Keep that object; the deleted subject's references are gone.
      const shared=task.storage==='MEDIA'&&await maybe(services.pool,"SELECT id FROM media_assets WHERE (object_key=$1 OR original_object_key=$1) AND status NOT IN ('DELETED','DELETING') LIMIT 1",[task.objectKey]);
      if(!shared){
        const actualRoot=await fs.realpath(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        const parent=await fs.realpath(path.dirname(target)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(parent&&actualRoot&&parent!==actualRoot&&!parent.startsWith(actualRoot+path.sep))throw issue('UNSAFE_OBJECT_DIRECTORY');
        await fs.unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
        if(parent){const handle=await fs.open(parent,'r');try{await handle.sync();}finally{await handle.close();}}
      }
      await services.pool.query("UPDATE recovery_file_cleanup SET status='DONE',last_error=NULL,completed_at=clock_timestamp() WHERE id=$1",[task.id]);
    }catch(error:any){await services.pool.query('UPDATE recovery_file_cleanup SET last_error=$2 WHERE id=$1',[task.id,error.code||'FILE_DELETE_FAILED']);}
  }
}
async function queueOrphanFiles(services:Services,runId:string){
  for(const storage of ['MEDIA','EXPORT']as const){
    const root=storage==='MEDIA'?services.config.mediaDir:services.config.exportDir;
    let entries:import('node:fs').Dirent[];try{entries=await fs.readdir(root,{withFileTypes:true});}catch(error:any){if(error.code==='ENOENT')continue;throw error;}
    const keys:string[]=[];
    for(const entry of entries){
      if(entry.isFile())keys.push(entry.name);
      else if(storage==='MEDIA'&&entry.isDirectory())for(const file of await fs.readdir(path.join(root,entry.name),{withFileTypes:true}))if(file.isFile())keys.push(`${entry.name}/${file.name}`);
    }
    for(const key of keys){
      const referenced=storage==='MEDIA'&&await maybe(services.pool,"SELECT 1 FROM media_assets WHERE (object_key=$1 OR original_object_key=$1) AND status NOT IN ('DELETED','DELETING') LIMIT 1",[key]);
      if(!referenced)await services.pool.query('INSERT INTO recovery_file_cleanup(run_id,storage,object_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[runId,storage,key]);
    }
  }
}

export async function recoverFromJournal(services:Services,input:{journalCustodyConfirmed:boolean;operator:string}):Promise<RecoveryReport>{
  if(!input.operator.trim())throw issue('OPERATOR_REQUIRED');
  const runId=randomUUID(),report:RecoveryReport={runId,status:'HOLD',safeToStart:false,events:0,removedMemberships:[],unboundChildren:[],deletedFamilies:[],deletedAccounts:[],heldFamilies:[],blockedPinUsers:[],pendingFiles:0,issues:[]};
  const lock=await services.pool.connect();
  try{
    await lock.query('SELECT pg_advisory_lock(7543022)');
    await services.pool.query("INSERT INTO recovery_runs(id,operator,status) VALUES($1,$2,'RUNNING')",[runId,input.operator.trim()]);
    let events:Event[]=[];
    try{if(!input.journalCustodyConfirmed)throw issue('JOURNAL_CUSTODY_NOT_CONFIRMED');events=await readVerifiedJournal(services);report.events=events.length;}
    catch(error:any){
      report.issues.push({code:error.code||'JOURNAL_NOT_VERIFIED'});report.status='FAILED';
      await transaction(services.pool,async db=>{
        await beginRecovery(db);
        for(const f of await rows<any>(db,'SELECT id FROM families'))await holdFamily(db,f.id,'JOURNAL_NOT_VERIFIED',report);
        for(const u of await rows<any>(db,"SELECT u.id,COALESCE(p.credential_version,1) credential_version FROM users u LEFT JOIN pin_credentials p ON p.user_id=u.id WHERE u.status='ACTIVE'"))await blockPin(db,u.id,u.credentialVersion,new Date().toISOString(),report);
      });
      await services.pool.query("UPDATE recovery_runs SET status='FAILED',report=$2,completed_at=clock_timestamp() WHERE id=$1",[runId,JSON.stringify(report)]);return report;
    }
    try{
      await transaction(services.pool,async db=>{
        await beginRecovery(db);
        // Export archives contain snapshots of possibly revoked relationships.
        // Invalidate every restored archive, not only deletion-request archives.
        for(const p of await rows<any>(db,'SELECT export_object_key FROM privacy_requests WHERE export_object_key IS NOT NULL'))await queueFile(db,runId,'EXPORT',p.exportObjectKey);
        await db.query("UPDATE privacy_requests SET export_object_key=NULL,export_expires_at=NULL,status=CASE WHEN type='EXPORT' AND status IN ('RECEIVED','VERIFYING','PROCESSING','FAILED_RETRYABLE') THEN 'REJECTED' ELSE status END,user_visible_note=CASE WHEN type='EXPORT' THEN '恢复后原导出失效，请重新申请。' ELSE user_visible_note END");
        const familyDeletes=new Set<string>(),accountDeletes=new Map<string,string[]>(),latestRows=new Map<string,string>();
        for(const event of events){
          const p=event.payload;
          if(p.kind==='FAMILY_DELETED')familyDeletes.add(uuid.parse(p.familyId));
          if(p.kind==='ACCOUNT_DELETED')accountDeletes.set(uuid.parse(p.userId),z.array(uuid).parse(p.childIds??[]));
          if(p.kind==='ROW_CHANGE'){
            const r=camel<any>(p.row);latestRows.set(`${p.table}:${r.id}`,event.id);
            if(p.operation==='DELETE'&&p.table==='families')familyDeletes.add(uuid.parse(r.id));
          }
        }
        const pinEvents=new Map<string,Event>();
        for(const event of events){
          const p=event.payload;
          if(['PIN_ENROLLED','PIN_CHANGED','PIN_RECOVERED'].includes(p.kind)){
            const userId=uuid.parse(p.userId),prior=pinEvents.get(userId);version.parse(p.credentialVersion);
            if(!prior||p.credentialVersion>=prior.payload.credentialVersion)pinEvents.set(userId,event);continue;
          }
          if(p.kind==='ROW_CHANGE'){
            const r=camel<any>(p.row);if(latestRows.get(`${p.table}:${r.id}`)!==event.id)continue;
            if(familyDeletes.has(r.familyId??r.id)||accountDeletes.has(r.id)&&p.table==='users')continue;
            await replayRow(db,event,report);continue;
          }
          if(p.kind==='MEMBERSHIP_REMOVED')await removeMembership(db,{id:uuid.parse(p.membershipId),version:version.parse(p.version)},event.createdAt,report);
          else if(p.kind==='CHILD_UNBOUND')await unbind(db,{id:uuid.parse(p.childId),bindingVersion:version.parse(p.bindingVersion)},event.createdAt,report);
          else if(p.kind==='CHILD_ARCHIVED')await db.query("UPDATE child_profiles SET status='ARCHIVED',archived_at=COALESCE(archived_at,$2) WHERE id=$1",[uuid.parse(p.childId),event.createdAt]);
          else if(p.kind==='FAMILY_ARCHIVED')await db.query("UPDATE families SET status=CASE WHEN status='DELETING' THEN status ELSE 'ARCHIVED' END,archived_at=COALESCE(archived_at,$2) WHERE id=$1",[uuid.parse(p.familyId),event.createdAt]);
          else if(p.kind==='OWNERSHIP_TRANSFERRED'){
            const family=await maybe<any>(db,'SELECT * FROM families WHERE id=$1',[uuid.parse(p.familyId)]);
            if(family&&family.version<=p.version&&family.ownerMembershipId!==p.ownerMembershipId&&!familyDeletes.has(p.familyId))await holdFamily(db,p.familyId,'OWNER_CHANGED_AFTER_BACKUP',report);
          }
          else if(p.kind==='MEMBERSHIP_ADDED'){
            const m=await maybe<any>(db,'SELECT * FROM guardian_memberships WHERE id=$1',[uuid.parse(p.membershipId)]);
            if(!familyDeletes.has(p.familyId)&&(!m||(m.version<=p.version&&(m.status!=='ACTIVE'||m.userId!==p.userId))))await holdFamily(db,uuid.parse(p.familyId),'MEMBERSHIP_NOT_RECONSTRUCTABLE',report);
          }
          else if(p.kind==='CHILD_BOUND'){
            const c=await maybe<any>(db,'SELECT * FROM child_profiles WHERE id=$1',[uuid.parse(p.childId)]);
            if(!familyDeletes.has(p.familyId)&&(!c||(c.bindingVersion<=p.bindingVersion&&c.boundUserId!==p.userId)))await holdFamily(db,uuid.parse(p.familyId),'NEW_BINDING_NOT_RECONSTRUCTABLE',report);
          }
          else if(!['FAMILY_DELETED','ACCOUNT_DELETED'].includes(p.kind))throw issue('JOURNAL_UNKNOWN_EVENT');
        }
        for(const[userId,event]of pinEvents){
          if(accountDeletes.has(userId))continue;const p=event.payload;version.parse(p.credentialVersion);version.parse(p.securityVersion);
          if(p.pinEnabled!==true)throw issue('JOURNAL_PIN_STATE_INVALID');
          const credential=await maybe<any>(db,'SELECT * FROM pin_credentials WHERE user_id=$1',[userId]);
          if(!credential?.enabledAt||credential.credentialVersion<p.credentialVersion||credential.recoveryBlocked)await blockPin(db,userId,p.credentialVersion,event.createdAt,report);
          await db.query('UPDATE users SET security_version=GREATEST(security_version,$2) WHERE id=$1',[userId,p.securityVersion]);
        }
        for(const familyId of familyDeletes)await deleteRecoveredFamily(db,familyId,report);
        for(const[userId,children]of accountDeletes)await deleteRecoveredAccount(db,userId,children,report);
        report.heldFamilies=report.heldFamilies.filter(x=>!report.deletedFamilies.includes(x.familyId));
        await audit(db,null,'RECOVERY_REPLAY',{details:{runId,operator:input.operator.trim(),events:events.length,deletedFamilies:report.deletedFamilies,deletedAccounts:report.deletedAccounts}});
      });
      await queueOrphanFiles(services,runId);
      await purgeQueuedFiles(services);
      report.pendingFiles=(await one<any>(services.pool,"SELECT COUNT(*)::int count FROM recovery_file_cleanup WHERE status='PENDING'")).count;
      const reconciliation=await reconcile(services);report.reconciliationStatus=reconciliation.status;
      if(reconciliation.status!=='PASS')report.issues.push({code:'RECONCILIATION_FAILED'});
      const held=await rows<any>(services.pool,"SELECT id FROM families WHERE status='DELETING'");
      for(const f of held)if(!report.heldFamilies.some(x=>x.familyId===f.id))report.heldFamilies.push({familyId:f.id,reason:'EXISTING_RECOVERY_OR_DELETION_HOLD'});
      const pins=await rows<any>(services.pool,'SELECT user_id FROM pin_credentials WHERE recovery_blocked');for(const p of pins)if(!report.blockedPinUsers.includes(p.userId))report.blockedPinUsers.push(p.userId);
      report.safeToStart=!report.pendingFiles&&!report.issues.length&&!report.heldFamilies.length&&!report.blockedPinUsers.length;
      report.status=report.safeToStart?'READY':'HOLD';
    }catch(error:any){
      report.status='FAILED';report.issues.push({code:error.code||'RECOVERY_REPLAY_FAILED'});
      await transaction(services.pool,async db=>{
        await beginRecovery(db);
        for(const f of await rows<any>(db,'SELECT id FROM families'))await holdFamily(db,f.id,'RECOVERY_REPLAY_FAILED',report);
        for(const u of await rows<any>(db,"SELECT u.id,COALESCE(p.credential_version,1) credential_version FROM users u LEFT JOIN pin_credentials p ON p.user_id=u.id WHERE u.status='ACTIVE'"))await blockPin(db,u.id,u.credentialVersion,new Date().toISOString(),report);
      });
    }
    await services.pool.query('UPDATE recovery_runs SET status=$2,report=$3,completed_at=clock_timestamp() WHERE id=$1',[runId,report.status,JSON.stringify(report)]);
    return report;
  }finally{await lock.query('SELECT pg_advisory_unlock(7543022)');lock.release();}
}
