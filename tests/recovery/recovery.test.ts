import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../apps/api/src/migrate.js';
import { buildApp } from '../../apps/api/src/main.js';
import { loadConfig } from '../../apps/api/src/common/config.js';
import { one, rows, maybe, transaction, queueProtection } from '../../apps/api/src/common/index.js';
import { recoverFromJournal, readVerifiedJournal } from '../../apps/api/src/common/recovery.js';
import { reconcile, ensureChildAccount } from '../../apps/api/src/domain/index.js';
import { runPrivacyJobs } from '../../apps/api/src/privacy/index.js';

const databaseUrl=process.env.RECOVERY_TEST_DATABASE_URL||'postgresql://localhost/pointjoy_recovery_test';
const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
const parsed=new URL(databaseUrl);
if(parsed.pathname!=='/pointjoy_recovery_test')throw new Error('Recovery tests may replace only pointjoy_recovery_test');
const pgEnv={...process.env,PGDATABASE:'pointjoy_recovery_test',PGHOST:parsed.hostname,...(parsed.port?{PGPORT:parsed.port}:{}),...(parsed.username?{PGUSER:decodeURIComponent(parsed.username)}:{}),...(parsed.password?{PGPASSWORD:decodeURIComponent(parsed.password)}:{})};

test('real database backup, independent security journal and protected recovery',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pointjoy-recovery-test-'));
  const config={...loadConfig({APP_ENV:'test',DATABASE_URL:databaseUrl}),mediaDir:path.join(root,'media'),exportDir:path.join(root,'exports'),securityJournalDir:path.join(root,'journal')};
  const setup=new pg.Pool({connectionString:databaseUrl});await setup.query('DROP SCHEMA public CASCADE');await setup.query('CREATE SCHEMA public');await migrate(setup);await setup.end();
  let {app,services}=await buildApp(config);await app.ready();
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const mediaKeys:string[]=[];
  async function user(db:any,name:string){
    let u=await one(db,'INSERT INTO users(display_name) VALUES($1) RETURNING *',[name]);const key=`avatars/${randomUUID()}.jpg`;mediaKeys.push(key);
    const media=await one(db,"INSERT INTO media_assets(uploader_user_id,purpose,status,object_key,mime,width,height) VALUES($1,'USER_AVATAR','READY',$2,'image/jpeg',512,512) RETURNING *",[u.id,key]);
    u=await one(db,'UPDATE users SET avatar_media_id=$2,profile_completed_at=now() WHERE id=$1 RETURNING *',[u.id,media.id]);
    await db.query('INSERT INTO auth_identities(user_id,app_id,subject) VALUES($1,$2,$3)',[u.id,config.wechatAppId,name]);return u;
  }
  async function family(db:any,owner:any,name:string){
    const fid=randomUUID(),mid=randomUUID();await db.query('INSERT INTO families(id,name,owner_membership_id) VALUES($1,$2,$3)',[fid,name,mid]);
    await db.query('INSERT INTO guardian_memberships(id,family_id,user_id) VALUES($1,$2,$3)',[mid,fid,owner.id]);
    await db.query("INSERT INTO family_principals(family_id,user_id,kind,membership_id) VALUES($1,$2,'GUARDIAN',$3)",[fid,owner.id,mid]);return{id:fid,mid,name};
  }
  async function child(db:any,fid:string,parentId:string,name:string,bound?:string){
    const key=`avatars/${randomUUID()}.jpg`;mediaKeys.push(key);
    const media=await one(db,"INSERT INTO media_assets(uploader_user_id,family_id,purpose,status,object_key,mime,width,height) VALUES($1,$2,'CHILD_AVATAR','READY',$3,'image/jpeg',512,512) RETURNING *",[parentId,fid,key]);
    const c=await one(db,'INSERT INTO child_profiles(family_id,nickname,avatar_media_id,bound_user_id) VALUES($1,$2,$3,$4) RETURNING *',[fid,name,media.id,bound??null]);
    await db.query('UPDATE media_assets SET child_id=$2 WHERE id=$1',[media.id,c.id]);await ensureChildAccount(db,{familyId:fid,childId:c.id});
    if(bound)await db.query("INSERT INTO family_principals(family_id,user_id,kind,child_id) VALUES($1,$2,'CHILD',$3)",[fid,bound,c.id]);return c;
  }
  let owner:any,member:any,direct:any,subject:any,deleteOwner:any,main:any,deleted:any,c1:any,c2:any,c3:any,deleteChild:any,memberId:string;
  let parentToken:any,memberToken:any,childToken:any,subjectToken:any,deleteToken:any,pinRecoveryCode:string,oldPinHash:string;
  await transaction(services.pool,async db=>{
    owner=await user(db,'recovery-owner');member=await user(db,'recovery-member');direct=await user(db,'recovery-child');subject=await user(db,'recovery-subject');deleteOwner=await user(db,'recovery-delete-owner');
    main=await family(db,owner,'恢复测试家庭');deleted=await family(db,deleteOwner,'已申请删除家庭');
    memberId=(await one(db,'INSERT INTO guardian_memberships(family_id,user_id) VALUES($1,$2) RETURNING *',[main.id,member.id])).id;
    await db.query("INSERT INTO family_principals(family_id,user_id,kind,membership_id) VALUES($1,$2,'GUARDIAN',$3)",[main.id,member.id,memberId]);
    c1=await child(db,main.id,owner.id,'解绑孩子',direct.id);c2=await child(db,main.id,owner.id,'删除本人敏感资料',subject.id);c3=await child(db,main.id,owner.id,'等待新绑定');deleteChild=await child(db,deleted.id,deleteOwner.id,'家庭删除孩子');
    parentToken=await services.auth.issue(db,owner,'GUARDIAN',{familyId:main.id,membershipId:main.mid});memberToken=await services.auth.issue(db,member,'GUARDIAN',{familyId:main.id,membershipId:memberId});
    childToken=await services.auth.issue(db,direct,'CHILD',{familyId:main.id,childId:c1.id,bindingVersion:1,childSessionSource:'DIRECT'});subjectToken=await services.auth.issue(db,subject,'CHILD',{familyId:main.id,childId:c2.id,bindingVersion:1,childSessionSource:'DIRECT'});
    deleteToken=await services.auth.issue(db,deleteOwner,'GUARDIAN',{familyId:deleted.id,membershipId:deleted.mid});
  });
  for(const key of mediaKeys){await fs.mkdir(path.dirname(path.join(config.mediaDir,key)),{recursive:true});await fs.writeFile(path.join(config.mediaDir,key),'private avatar fixture');}
  async function call(who:any,method:any,url:string,body?:any,expected=200){
    const r=await app.inject({method,url:'/api/v1'+url,headers:{...(who?{authorization:'Bearer '+who.accessToken}:{}),'idempotency-key':randomUUID()},...(body===undefined?{}:{payload:body})});
    const j=r.json();assert.equal(r.statusCode,expected,`${method} ${url}: ${JSON.stringify(j.error||{})}`);return j.data??j;
  }
  async function step(who:any,action:string,pin?:string,code?:string){return(await call(who,'POST','/auth/step-up',{action,...(pin?{pin}:{}),...(code?{newWechatCode:code}:{})})).stepUpToken;}
  let evidenceKey='',evidenceId='',occurrenceId='',exportKey=randomUUID()+'.zip';
  await t.test('baseline includes valid PIN, private media, child text, points and bearer grants',async()=>{
    const enrollment=await call(parentToken,'POST','/auth/pin/enroll',{pin:'135790',confirmationPin:'135790'});pinRecoveryCode=enrollment.recoveryCode;
    await call(parentToken,'POST','/auth/pin/enroll/confirm',{enrollmentId:enrollment.enrollmentId,recoverySaved:true});
    oldPinHash=(await one(services.pool,'SELECT pin_hash FROM pin_credentials WHERE user_id=$1',[owner.id])).pinHash;
    let p=await call(parentToken,'POST',`/families/${main.id}/plans`,{type:'ROUTINE',title:'本人活动',metric:'CHECK',awardPoints:10,childIds:[c2.id],weekdays:[1,2,3,4,5,6,7]});
    await call(parentToken,'POST',`/families/${main.id}/plans/${p.id}/publish`,{expectedVersion:p.version,startPolicy:'TODAY'});
    const o=(await call(parentToken,'GET',`/families/${main.id}/children/${c2.id}/today`)).routines[0];occurrenceId=o.id;evidenceKey=`evidence/${randomUUID()}.jpg`;
    evidenceId=(await one(services.pool,"INSERT INTO media_assets(uploader_user_id,family_id,child_id,occurrence_id,purpose,status,object_key,mime,width,height,retention_until) VALUES($1,$2,$3,$4,'COMPLETION_EVIDENCE','READY',$5,'image/jpeg',800,600,now()+interval '24 hours') RETURNING id",[owner.id,main.id,c2.id,o.id,evidenceKey])).id;
    await fs.mkdir(path.join(config.mediaDir,'evidence'),{recursive:true});await fs.writeFile(path.join(config.mediaDir,evidenceKey),'private completion fixture');
    await call(parentToken,'POST',`/families/${main.id}/occurrences/${o.id}/direct-completion`,{checked:true,note:'应被删除的个人敏感文字',mediaIds:[evidenceId],completedAt:new Date().toISOString(),expectedVersion:1});
    await call(deleteToken,'POST',`/families/${deleted.id}/children/${deleteChild.id}/praises`,{points:5,reason:'家庭内待删除文字'});
    await one(services.pool,"INSERT INTO privacy_requests(user_id,family_id,type,scope,status,due_at,export_object_key,export_expires_at) VALUES($1,$2,'EXPORT','FAMILY','COMPLETED',now(),$3,now()+interval '7 days') RETURNING id",[owner.id,main.id,exportKey]);await fs.writeFile(path.join(config.exportDir,exportKey),'private export fixture');
    await call(parentToken,'POST',`/media/${evidenceId}/read-grants`,{});
    await transaction(services.pool,db=>services.auth.saveAttempt(db,'QA',randomUUID(),'not-a-real-secret',{session:{sessionId:parentToken.session.sessionId}}));
    await services.flushSecurityJournal();assert.equal((await reconcile(services)).status,'PASS');
  });

  const dump=path.join(root,'before.dump'),mediaBackup=path.join(root,'media-before'),exportsBackup=path.join(root,'exports-before');
  await t.test('pg_dump and private-file backup are separate from the sealed journal',async()=>{
    execFileSync(process.env.PG_DUMP_BIN||'pg_dump',['--format=custom','--file',dump],{env:pgEnv,stdio:'pipe'});
    await fs.cp(config.mediaDir,mediaBackup,{recursive:true});await fs.cp(config.exportDir,exportsBackup,{recursive:true});
    const events=await readVerifiedJournal(services);assert.ok(events.length);
    for(const e of events)assert.ok(!/pin_hash|pinHash|recovery_hash|recoveryHash|accessToken|refreshToken/.test(JSON.stringify(e.payload)),'journal cannot contain credentials');
  });
  await t.test('a complete unchanged authority snapshot can become READY without blocking its current PIN',async()=>{
    const clean=await recoverFromJournal(services,{operator:'baseline-recovery-test',journalCustodyConfirmed:true});assert.equal(clean.status,'READY',JSON.stringify(clean));assert.equal(clean.safeToStart,true);
    const pin=await one(services.pool,'SELECT pin_hash,recovery_blocked FROM pin_credentials WHERE user_id=$1',[owner.id]);assert.equal(pin.pinHash,oldPinHash);assert.equal(pin.recoveryBlocked,false);
    // Recovery deliberately revoked all earlier sessions. Create the next test
    // fixtures through the real session issuer before subsequent live changes.
    await transaction(services.pool,async db=>{
      parentToken=await services.auth.issue(db,owner,'GUARDIAN',{familyId:main.id,membershipId:main.mid,pinVerifiedAt:new Date()});
      memberToken=await services.auth.issue(db,member,'GUARDIAN',{familyId:main.id,membershipId:memberId});
      childToken=await services.auth.issue(db,direct,'CHILD',{familyId:main.id,childId:c1.id,bindingVersion:1,childSessionSource:'DIRECT'});
      subjectToken=await services.auth.issue(db,subject,'CHILD',{familyId:main.id,childId:c2.id,bindingVersion:1,childSessionSource:'DIRECT'});
      deleteToken=await services.auth.issue(db,deleteOwner,'GUARDIAN',{familyId:deleted.id,membershipId:deleted.mid});
    });
  });
  await t.test('new removals, unbinding, privacy deletion and PIN change are acknowledged after sealing',async()=>{
    await call(parentToken,'POST',`/families/${main.id}/guardians/${memberId!}/remove`,{expectedVersion:1,reason:'撤销这个成员'});
    await call(parentToken,'POST',`/families/${main.id}/children/${c1.id}/unbind`,{expectedBindingVersion:1,reason:'解除直登绑定',stepUpToken:await step(parentToken,'UNBIND_CHILD','135790')});
    await call(subjectToken,'POST','/me/privacy-requests',{type:'DELETE',scope:'SELF_ACCOUNT',confirmation:{confirmed:true,deleteOwnChildSensitiveDataConfirmed:true},stepUpToken:await step(subjectToken,'DELETE_SELF',undefined,'local:recovery-subject')},202);
    let f=await call(deleteToken,'POST',`/families/${deleted.id}/archive`,{expectedVersion:1,retainLedgersConfirmed:true,stepUpToken:await step(deleteToken,'ARCHIVE_FAMILY',undefined,'local:recovery-delete-owner')});assert.equal(f.status,'ARCHIVED');
    await call(deleteToken,'POST',`/families/${deleted.id}/privacy-requests`,{type:'DELETE',scope:'FAMILY',confirmation:{confirmed:true,familyName:deleted.name,deleteNonzeroBalancesConfirmed:true},stepUpToken:await step(deleteToken,'DELETE_FAMILY',undefined,'local:recovery-delete-owner')},202);
    await runPrivacyJobs(services);await services.flushSecurityJournal();
    assert.equal(await maybe(services.pool,'SELECT id FROM families WHERE id=$1',[deleted.id]),null);
    assert.equal((await one(services.pool,'SELECT status FROM users WHERE id=$1',[subject.id])).status,'DISABLED');
    await call(parentToken,'POST','/auth/pin/change',{oldPin:'135790',newPin:'246802',confirmationPin:'246802'});
    // A newer binding lacks the required complete restored profile/relationship;
    // replay must never synthesize that grant from minimal security metadata.
    await transaction(services.pool,async db=>{
      const newcomer=await user(db,'recovery-newcomer');
      await db.query('UPDATE child_profiles SET bound_user_id=$2,binding_version=2,version=2 WHERE id=$1',[c3.id,newcomer.id]);
      await db.query("INSERT INTO family_principals(family_id,user_id,kind,child_id) VALUES($1,$2,'CHILD',$3)",[main.id,newcomer.id,c3.id]);
      await queueProtection(db,'CHILD_BOUND',{familyId:main.id,childId:c3.id,userId:newcomer.id,bindingVersion:2});
    });
    await services.flushSecurityJournal();assert.equal((await reconcile(services)).status,'PASS');
  });

  async function restore(){
    await app.close();
    execFileSync(process.env.PG_RESTORE_BIN||'pg_restore',['--clean','--if-exists','--exit-on-error','--dbname','pointjoy_recovery_test',dump],{env:pgEnv,stdio:'pipe'});
    await fs.rm(config.mediaDir,{recursive:true,force:true});await fs.rm(config.exportDir,{recursive:true,force:true});
    await fs.cp(mediaBackup,config.mediaDir,{recursive:true});await fs.cp(exportsBackup,config.exportDir,{recursive:true});
    ({app,services}=await buildApp(config));await app.ready();
  }
  let report:any;
  await t.test('old backup really restores removed permissions and deleted data before replay',async()=>{
    await restore();
    assert.equal((await one(services.pool,'SELECT status FROM guardian_memberships WHERE id=$1',[memberId!])).status,'ACTIVE');
    assert.equal((await one(services.pool,'SELECT bound_user_id FROM child_profiles WHERE id=$1',[c1.id])).boundUserId,direct.id);
    assert.equal((await one(services.pool,'SELECT pin_hash FROM pin_credentials WHERE user_id=$1',[owner.id])).pinHash,oldPinHash);
    assert.ok(await maybe(services.pool,'SELECT id FROM families WHERE id=$1',[deleted.id]));
    assert.equal((await one(services.pool,'SELECT note FROM completion_submissions WHERE occurrence_id=$1',[occurrenceId])).note,'应被删除的个人敏感文字');
    assert.equal((await reconcile(services)).status,'PASS');
  });
  await t.test('replay revokes sessions, removes old authority, purges private copies, and holds unknown grants',async()=>{
    report=await recoverFromJournal(services,{operator:'recovery-test',journalCustodyConfirmed:true});
    assert.equal(report.status,'HOLD',JSON.stringify(report));assert.equal(report.pendingFiles,0);assert.equal(report.reconciliationStatus,'PASS');
    assert.ok(report.blockedPinUsers.includes(owner.id));assert.ok(report.heldFamilies.some((x:any)=>x.familyId===main.id));
    assert.equal((await one(services.pool,'SELECT status FROM guardian_memberships WHERE id=$1',[memberId!])).status,'REMOVED');
    assert.equal((await one(services.pool,'SELECT bound_user_id FROM child_profiles WHERE id=$1',[c1.id])).boundUserId,null);
    assert.equal((await one(services.pool,'SELECT bound_user_id FROM child_profiles WHERE id=$1',[c3.id])).boundUserId,null);
    assert.equal(await maybe(services.pool,'SELECT id FROM families WHERE id=$1',[deleted.id]),null);
    assert.equal((await one(services.pool,'SELECT status,display_name FROM users WHERE id=$1',[subject.id])).status,'DISABLED');
    assert.equal((await one(services.pool,'SELECT note FROM completion_submissions WHERE occurrence_id=$1',[occurrenceId])).note,'');
    assert.equal((await one(services.pool,"SELECT COUNT(*)::int n FROM operation_records WHERE response::text LIKE '%应被删除的个人敏感文字%'")).n,0);
    await assert.rejects(fs.stat(path.join(config.mediaDir,evidenceKey)),(e:any)=>e.code==='ENOENT');
    await assert.rejects(fs.stat(path.join(config.exportDir,exportKey)),(e:any)=>e.code==='ENOENT');
    for(const table of ['auth_attempts','step_up_grants','media_read_grants','export_read_grants'])assert.equal((await one(services.pool,`SELECT COUNT(*)::int n FROM ${table}`)).n,0);
    assert.equal((await one(services.pool,'SELECT COUNT(*)::int n FROM auth_sessions WHERE revoked_at IS NULL')).n,0);
    assert.equal((await one(services.pool,'SELECT COUNT(*)::int n FROM recovery_file_cleanup WHERE status=\'PENDING\'')).n,0);
  });
  await t.test('WeChat cannot unlock restored old PIN/recovery code or revive removed contexts',async()=>{
    for(const token of [parentToken,memberToken,childToken])await call(token,'GET','/auth/session',undefined,401);
    const login=await call(null,'POST','/auth/wechat/login',{code:'local:recovery-owner',loginAttemptId:randomUUID()});assert.equal(login.session.mode,'LOCKED');
    const credential=await one(services.pool,'SELECT pin_hash,recovery_hash,recovery_blocked FROM pin_credentials WHERE user_id=$1',[owner.id]);assert.equal(credential.pinHash,null);assert.equal(credential.recoveryHash,null);assert.equal(credential.recoveryBlocked,true);
    const oldPin=await call(login,'POST','/auth/pin/unlock',{pin:'135790'},403);assert.equal(oldPin.error.code,'PIN_RECOVERY_REQUIRED');
    const oldRecovery=await call(login,'POST','/auth/pin/recover',{newWechatCode:'local:recovery-owner',recoveryCode:pinRecoveryCode!,newPin:'975310',confirmationPin:'975310',recoveryAttemptId:randomUUID()},403);assert.equal(oldRecovery.error.code,'PIN_RECOVERY_REQUIRED');
    const removed=await call(null,'POST','/auth/wechat/login',{code:'local:recovery-member',loginAttemptId:randomUUID()});assert.equal((await call(removed,'GET','/me/contexts')).items.length,0);
    const unbound=await call(null,'POST','/auth/wechat/login',{code:'local:recovery-child',loginAttemptId:randomUUID()});assert.equal((await call(unbound,'GET','/me/contexts')).items.length,0);
    assert.equal((await reconcile(services)).status,'PASS');
  });
  await t.test('replaying twice stays conservative and does not recreate credentials or deleted records',async()=>{
    const again=await recoverFromJournal(services,{operator:'recovery-test-repeat',journalCustodyConfirmed:true});assert.equal(again.status,'HOLD',JSON.stringify(again));assert.equal(again.pendingFiles,0);
    assert.equal(await maybe(services.pool,'SELECT id FROM families WHERE id=$1',[deleted.id]),null);assert.equal((await one(services.pool,'SELECT recovery_blocked FROM pin_credentials WHERE user_id=$1',[owner.id])).recoveryBlocked,true);
    assert.equal((await reconcile(services)).status,'PASS');
  });
  await t.test('missing sealed event fails closed even when it happened after the database backup',async()=>{
    await restore();const manifest=JSON.parse(await fs.readFile(path.join(config.securityJournalDir,'manifest.json'),'utf8'));
    const baselineIds=new Set((await rows<any>(services.pool,"SELECT id FROM outbox WHERE event_type='SECURITY_PROTECTION'")).map(x=>x.id));const event=manifest.entries.find((e:any)=>!baselineIds.has(e.id));assert.ok(event);
    const file=path.join(config.securityJournalDir,event.file),bytes=await fs.readFile(file);await fs.unlink(file);
    const failed=await recoverFromJournal(services,{operator:'missing-journal-test',journalCustodyConfirmed:true});assert.equal(failed.status,'FAILED');assert.ok(failed.issues.some(x=>x.code==='JOURNAL_FILE_MISSING'));assert.equal(failed.safeToStart,false);
    assert.equal((await one(services.pool,"SELECT COUNT(*)::int n FROM families WHERE status<>'DELETING'")).n,0);assert.equal((await one(services.pool,'SELECT COUNT(*)::int n FROM auth_sessions WHERE revoked_at IS NULL')).n,0);
    await fs.writeFile(file,bytes);
  });
  await t.test('unconfirmed independent journal custody refuses recovery without reconstructing a manifest',async()=>{
    await restore();const result=await recoverFromJournal(services,{operator:'custody-test',journalCustodyConfirmed:false});assert.equal(result.status,'FAILED');assert.equal(result.issues[0].code,'JOURNAL_CUSTODY_NOT_CONFIRMED');assert.equal(result.safeToStart,false);
    assert.equal((await one(services.pool,"SELECT COUNT(*)::int n FROM families WHERE status<>'DELETING'")).n,0);
  });
  await t.test('tampered signed manifest fails closed without disclosing its content',async()=>{
    await restore();const file=path.join(config.securityJournalDir,'manifest.json'),bytes=await fs.readFile(file),manifest=JSON.parse(bytes.toString());manifest.sealedAt='2000-01-01T00:00:00.000Z';await fs.writeFile(file,JSON.stringify(manifest));
    const result=await recoverFromJournal(services,{operator:'manifest-test',journalCustodyConfirmed:true});assert.equal(result.status,'FAILED');assert.equal(result.issues[0].code,'JOURNAL_SIGNATURE_INVALID');assert.equal(result.safeToStart,false);await fs.writeFile(file,bytes);
  });
  await t.test('the real recovery CLI returns exit one while any protected account remains unresolved',async()=>{
    const executable=path.join(repositoryRoot,'node_modules/.bin/tsx');
    const result=spawnSync(executable,[path.join(repositoryRoot,'apps/api/src/recovery.ts'),'--operator','cli-recovery-test','--journal-custody-confirmed'],{encoding:'utf8',env:{...process.env,APP_ENV:'test',DATABASE_URL:databaseUrl,MEDIA_DIR:config.mediaDir,EXPORT_DIR:config.exportDir,SECURITY_JOURNAL_DIR:config.securityJournalDir}});
    assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);
    assert.equal(result.status,1,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.safeToStart,false);assert.ok(['HOLD','FAILED'].includes(report.status));assert.ok(!result.stdout.includes(oldPinHash));
  });
});
