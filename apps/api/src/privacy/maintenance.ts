import { createHash, createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { z } from 'zod';
import { AppError, audit, canonical, one, rows, transaction, type Db } from '../common/index.js';

const DAY=86_400_000;
const configSchema=z.object({
 version:z.literal(1),
 backupDirectories:z.array(z.object({path:z.string().min(1),kind:z.enum(['ROTATING','LEGACY']),keyFile:z.string().min(1)}).strict()).length(2),
 exportDirectory:z.string().min(1),backupLockFile:z.string().min(1),
 maxLatestBackupAgeMinutes:z.number().int().min(10).max(60).default(30),
}).strict();
export type MaintenanceConfig=z.infer<typeof configSchema>;
type Runtime={environment:'production'|'test';databaseUrl:string};
type FileRecord={path:string;relativePath:string;size:number;mtimeMs:number;birthtimeMs:number;inode:number;device:number;capturedAt:number;kind:'ROTATING'|'LEGACY'|'EXPORT'};
type Inventory={backups:FileRecord[];exports:FileRecord[];errors:string[];fingerprint:string;verifiedLatestSha256?:string;latestBackupAt?:string;backupDirectories:string[]};
const operatorSchema=z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9@._+-]+$/,'操作人使用独立可追责的账号标识');
const fileFailure=(code:string,location:string)=>`${code}:${location}`;

/** No wall-clock override is accepted. Tests age fixture rows/files instead. */
export function validateMaintenanceConfig(input:unknown,runtime:Runtime):MaintenanceConfig{
 const c=configSchema.parse(input);const kinds=c.backupDirectories.map(x=>x.kind);
 if(new Set(kinds).size!==2)throw new Error('BOTH_BACKUP_KINDS_REQUIRED');
 for(const p of [...c.backupDirectories.flatMap(x=>[x.path,x.keyFile]),c.exportDirectory,c.backupLockFile])if(!path.isAbsolute(p)||path.normalize(p)!==p)throw new Error('ABSOLUTE_CANONICAL_PATH_REQUIRED');
 if(new Set(c.backupDirectories.map(x=>x.path)).size!==2)throw new Error('DUPLICATE_BACKUP_DIRECTORY');
 if(runtime.environment==='production'){
  const expected={ROTATING:'/var/backups/pointjoy-v1',LEGACY:'/var/backups/pointjoy-rebuild'};
  for(const d of c.backupDirectories)if(d.path!==expected[d.kind]||d.keyFile!=='/etc/pointjoy/backup.key')throw new Error('PRODUCTION_BACKUP_SCOPE_MISMATCH');
  if(c.exportDirectory!=='/var/lib/pointjoy/exports'||c.backupLockFile!=='/run/lock/pointjoy-backup.lock')throw new Error('PRODUCTION_STORAGE_SCOPE_MISMATCH');
  if(new URL(runtime.databaseUrl).username!=='pointjoy_privacy')throw new Error('PRIVACY_DATABASE_ROLE_REQUIRED');
 }else{
  const u=new URL(runtime.databaseUrl);
  if(!['localhost','127.0.0.1',''].includes(u.hostname)||u.pathname!=='/pointjoy_privacy_maintenance_qa')throw new Error('TEST_DATABASE_SCOPE_REQUIRED');
 }
 return c;
}
async function requireProductionLock(c:MaintenanceConfig){
 if(process.getuid?.()!==0)throw new Error('ROOT_BACKUP_READER_REQUIRED');
 const fd=process.env.POINTJOY_BACKUP_LOCK_FD;
 if(!fd||!/^\d+$/.test(fd))throw new Error('BACKUP_LOCK_REQUIRED');
 const real=await fs.realpath(`/proc/self/fd/${fd}`),expected=await fs.realpath(c.backupLockFile);
 const info=await fs.readFile(`/proc/self/fdinfo/${fd}`,'utf8');
 if(real!==expected||!/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s/m.test(info))throw new Error('EXCLUSIVE_BACKUP_LOCK_NOT_HELD');
}
function filenameTime(name:string,kind:FileRecord['kind']):number|null{
 if(kind==='EXPORT')return /^[a-f0-9-]{36}\.zip$/.test(name)?null:NaN;
 if(kind==='LEGACY')return name==='before-v1.dump.enc'?null:NaN;
 const m=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tgz\.enc$/.exec(name);if(!m)return NaN;
 const iso=`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,time=Date.parse(iso);
 return Number.isFinite(time)&&new Date(time).toISOString()===iso.replace('Z','.000Z')?time:NaN;
}
async function scanDirectory(directory:string,kind:FileRecord['kind'],production:boolean):Promise<{files:FileRecord[];errors:string[]}>{
 const files:FileRecord[]=[],errors:string[]=[];
 try{
  const top=await fs.lstat(directory);
  if(!top.isDirectory()||top.isSymbolicLink()||await fs.realpath(directory)!==directory){errors.push(fileFailure('UNTRUSTED_DIRECTORY',directory));return{files,errors};}
  if(production&&(top.mode&0o022||kind!=='EXPORT'&&top.uid!==0)){errors.push(fileFailure('UNTRUSTED_DIRECTORY_PERMISSIONS',directory));return{files,errors};}
  const walk=async(current:string,depth:number)=>{
   if(depth>3)throw new Error('UNEXPECTED_NESTED_STORAGE');
   for(const entry of (await fs.readdir(current)).sort()){
    if(files.length>=100_000)throw new Error('STORAGE_INVENTORY_TOO_LARGE');
    const full=path.join(current,entry),st=await fs.lstat(full);
    if(st.isSymbolicLink()||!st.isFile()){errors.push(fileFailure('UNEXPECTED_STORAGE_ENTRY',full));continue;}
    if(production&&(st.mode&0o022||kind!=='EXPORT'&&st.uid!==0)){errors.push(fileFailure('UNTRUSTED_FILE_PERMISSIONS',full));continue;}
    const captured=filenameTime(entry,kind);
    if(Number.isNaN(captured)){errors.push(fileFailure('UNKNOWN_OR_PARTIAL_FILE',full));continue;}
    const instants=[st.mtimeMs,...(st.birthtimeMs>0?[st.birthtimeMs]:[]),...(captured!==null?[captured]:[])];
    files.push({path:full,relativePath:path.relative(directory,full),size:st.size,mtimeMs:st.mtimeMs,birthtimeMs:st.birthtimeMs,inode:st.ino,device:st.dev,capturedAt:Math.min(...instants),kind});
   }
  };
  await walk(directory,0);
 }catch(e:any){errors.push(fileFailure(e.code==='ENOENT'?'DIRECTORY_MISSING':e.code==='EACCES'?'DIRECTORY_UNREADABLE':'DIRECTORY_SCAN_FAILED',directory));}
 return{files,errors};
}
async function authenticateBackup(file:FileRecord,keyPath:string,production:boolean):Promise<string>{
 const keyStat=await fs.lstat(keyPath);if(!keyStat.isFile()||keyStat.isSymbolicLink()||production&&(keyStat.uid!==0||keyStat.mode&0o077))throw new Error('UNTRUSTED_BACKUP_KEY');
 const raw=await fs.readFile(keyPath);if(raw.length<24)throw new Error('INVALID_BACKUP_KEY');
 const key=createHash('sha256').update(raw).digest(),magic=Buffer.from('PJBGCM1');
 const handle=await fs.open(file.path,'r');const header=Buffer.alloc(19),tag=Buffer.alloc(16);let before:any;
 try{before=await handle.stat();if(before.size<36||before.ino!==file.inode||before.mtimeMs!==file.mtimeMs)throw new Error('BACKUP_CHANGED_DURING_CHECK');await handle.read(header,0,19,0);await handle.read(tag,0,16,before.size-16);}finally{await handle.close();}
 if(!header.subarray(0,7).equals(magic))throw new Error('UNKNOWN_BACKUP_FORMAT');
 const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(7));decipher.setAAD(magic);decipher.setAuthTag(tag);
 const checksum=createHash('sha256').update(header),stream=createReadStream(file.path,{start:19,end:before.size-17});stream.on('data',(chunk:any)=>checksum.update(chunk));
 let total=0;await pipeline(stream,decipher,new Writable({write(chunk,_encoding,next){total+=chunk.length;next();}}));
 if(total===0)throw new Error('EMPTY_BACKUP');checksum.update(tag);
 const after=await fs.stat(file.path);if(after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('BACKUP_CHANGED_DURING_CHECK');return checksum.digest('hex');
}
async function inventory(c:MaintenanceConfig,production:boolean,now:number,authenticate=true):Promise<Inventory>{
 const backups:FileRecord[]=[],exports:FileRecord[]=[],errors:string[]=[];
 if(production){try{const extra=(await fs.readdir('/var/backups')).filter(name=>name==='pointjoy'||name.startsWith('pointjoy-stage.'));for(const name of extra)errors.push(fileFailure('UNREGISTERED_RAW_BACKUP_COPY',path.join('/var/backups',name)));}catch{errors.push('BACKUP_PARENT_INVENTORY_UNAVAILABLE');}}
 for(const d of c.backupDirectories){const result=await scanDirectory(d.path,d.kind,production);backups.push(...result.files);errors.push(...result.errors);}
 const e=await scanDirectory(c.exportDirectory,'EXPORT',production);exports.push(...e.files);errors.push(...e.errors);
 for(const f of backups)if(f.capturedAt>now+300_000)errors.push(fileFailure('BACKUP_TIMESTAMP_IN_FUTURE',f.path));
 const latest=backups.filter(f=>f.kind==='ROTATING').sort((a,b)=>b.capturedAt-a.capturedAt)[0];
 let verifiedLatestSha256:string|undefined;
 if(!latest)errors.push('NO_RECENT_ROTATING_BACKUP');
 else if(now-latest.capturedAt>c.maxLatestBackupAgeMinutes*60_000)errors.push('LATEST_BACKUP_TOO_OLD');
 else if(authenticate){try{const rotating=c.backupDirectories.find(d=>d.kind==='ROTATING')!;verifiedLatestSha256=await authenticateBackup(latest,rotating.keyFile,production);}catch{errors.push('LATEST_BACKUP_AUTHENTICATION_FAILED');}}
 const fingerprint=createHash('sha256').update(canonical([...backups,...exports].map(f=>({path:f.path,size:f.size,mtimeMs:f.mtimeMs,inode:f.inode,device:f.device})).sort((a,b)=>a.path.localeCompare(b.path)))).digest('hex');
 return{backups,exports,errors,fingerprint,verifiedLatestSha256,latestBackupAt:latest?new Date(latest.capturedAt).toISOString():undefined,backupDirectories:c.backupDirectories.map(d=>d.path)};
}
async function exportReasons(db:Db,p:any,scan:Inventory,cutoff:number){
 const records=await rows(db,'SELECT id,user_id,family_id,requested_at,export_object_key,export_expires_at FROM privacy_requests WHERE export_object_key IS NOT NULL');
 const known=new Map(records.map(r=>[r.exportObjectKey,r]));const reasons:string[]=[];
 for(const f of scan.exports){const r=known.get(f.relativePath);if(!r){reasons.push(fileFailure('UNTRACKED_EXPORT_COPY',f.relativePath));continue;}if(f.capturedAt<=cutoff||Date.parse(r.requestedAt)<=cutoff||Date.parse(r.exportExpiresAt)<=Date.now())reasons.push(fileFailure('OLD_OR_EXPIRED_EXPORT_COPY',f.relativePath));if(r.userId===p.userId&&p.scope==='SELF_ACCOUNT')reasons.push(fileFailure('DELETED_SUBJECT_EXPORT_COPY',f.relativePath));}
 const missing=records.filter(r=>!scan.exports.some(f=>f.relativePath===r.exportObjectKey));if(missing.length)reasons.push('EXPORT_DATABASE_FILE_MISMATCH');
 return[...new Set(reasons)];
}
export async function confirmBackupPurge(pool:pg.Pool,input:unknown,runtime:Runtime,operator:string,options:{dryRun?:boolean;requestId?:string}={}){
 const c=validateMaintenanceConfig(input,runtime);operatorSchema.parse(operator);if(options.requestId)z.string().uuid().parse(options.requestId);
 if(runtime.environment==='production')await requireProductionLock(c);
 const db=await pool.connect();
 try{
  const acquired=(await db.query('SELECT pg_try_advisory_lock(74321101) AS acquired')).rows[0].acquired;if(!acquired)throw new Error('PRIVACY_MAINTENANCE_ALREADY_RUNNING');
  const clock=await one(db,'SELECT clock_timestamp() AS now'),now=Date.parse(clock.now),scan=await inventory(c,runtime.environment==='production',now);
  const markers=await rows(db,`SELECT t.*,p.type,p.scope,p.user_id,p.status AS request_status,p.outcome_code,p.completed_at AS online_completed_at FROM deletion_tombstones t LEFT JOIN privacy_requests p ON p.id=t.request_id WHERE ($1::uuid IS NULL OR t.request_id=$1) ORDER BY t.deleted_at,t.id`,[options.requestId??null]);
  const results:any[]=[];if(options.requestId&&!markers.length)throw new AppError(404,'DELETION_MARKER_NOT_FOUND','此申请尚无在线删除完成标记');
  for(const t of markers){
   const cutoff=Math.max(Date.parse(t.deletedAt),Date.parse(t.onlineCompletedAt||t.deletedAt)),earliest=cutoff+35*DAY;
   const result:any={requestId:t.requestId,tombstoneId:t.id,backupPurgeDueAt:new Date(Math.max(earliest,Date.parse(t.backupPurgeDueAt))).toISOString(),state:'PENDING',reasons:[]};
   if(t.completedAt){result.state='ALREADY_COMPLETED';result.completedAt=t.completedAt;results.push(result);continue;}
   if(now<earliest||now<Date.parse(t.backupPurgeDueAt)){result.state='NOT_DUE';result.reasons=['MINIMUM_35_DAYS_NOT_ELAPSED'];results.push(result);continue;}
   if(t.type!=='DELETE'||t.requestStatus!=='COMPLETED'||t.outcomeCode!=='ONLINE_DELETION_COMPLETED'||!t.onlineCompletedAt)result.reasons.push('ONLINE_DELETION_NOT_CONFIRMED');
   result.reasons.push(...scan.errors);
   for(const backup of scan.backups)if(backup.capturedAt<=cutoff)result.reasons.push(fileFailure('OLD_BACKUP_REMAINS',backup.path));
   result.reasons.push(...await exportReasons(db,t,scan,cutoff));
   if(!result.reasons.length){const recheck=await inventory(c,runtime.environment==='production',now,false);if(recheck.errors.length||recheck.fingerprint!==scan.fingerprint)result.reasons.push('STORAGE_CHANGED_DURING_CHECK');}
   if(!result.reasons.length&&options.dryRun)result.state='ELIGIBLE';
   else if(!result.reasons.length){
    await db.query('BEGIN');try{
     const current=await one(db,'SELECT * FROM deletion_tombstones WHERE id=$1 FOR UPDATE',[t.id]);
     const request=await one(db,'SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE',[t.requestId]);
     if(current.completedAt){result.state='ALREADY_COMPLETED';result.completedAt=current.completedAt;}
     else if(request.status!=='COMPLETED'||request.outcomeCode!=='ONLINE_DELETION_COMPLETED'||Date.parse(request.completedAt)!==Date.parse(t.onlineCompletedAt)||Date.parse(current.backupPurgeDueAt)>now||Date.parse(current.deletedAt)!==Date.parse(t.deletedAt)){result.reasons.push('DELETION_STATE_CHANGED');}
     else{
      const updated=await one(db,`UPDATE deletion_tombstones SET completed_at=clock_timestamp(),clear_after=clock_timestamp()+interval '30 days' WHERE id=$1 RETURNING completed_at,clear_after`,[t.id]);
      await db.query(`UPDATE privacy_requests SET user_visible_note=COALESCE(user_visible_note,'')||' 备份轮换已实际核验完成；最少处理回执继续保留30天。',version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[t.requestId]);
      await audit(db,null,'BACKUP_PURGE_CONFIRMED',{sourceId:t.requestId,details:{operator,tombstoneId:t.id,backupDirectories:scan.backupDirectories,checkedBackupCount:scan.backups.length,inventoryFingerprint:scan.fingerprint,latestBackupAt:scan.latestBackupAt,verifiedLatestSha256:scan.verifiedLatestSha256,completedAt:updated.completedAt,clearAfter:updated.clearAfter}});
      result.state='COMPLETED';result.completedAt=updated.completedAt;result.clearAfter=updated.clearAfter;
     }
     await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}
   }
   if(result.state==='PENDING'&&!options.dryRun){const recent=await rows(db,`SELECT id FROM audit_logs WHERE source_id=$1 AND action='BACKUP_PURGE_PENDING' AND details->>'reasonsHash'=$2 AND created_at>clock_timestamp()-interval '1 day' LIMIT 1`,[t.requestId,createHash('sha256').update(canonical(result.reasons)).digest('hex')]);if(!recent.length)await audit(db,null,'BACKUP_PURGE_PENDING',{sourceId:t.requestId,details:{operator,reasons:result.reasons,reasonsHash:createHash('sha256').update(canonical(result.reasons)).digest('hex')}});}
   results.push(result);
  }
  return{checkedAt:clock.now,dryRun:!!options.dryRun,storageErrors:scan.errors,checkedBackupCount:scan.backups.length,inventoryFingerprint:scan.fingerprint,latestBackupAt:scan.latestBackupAt,results};
 }finally{try{await db.query('SELECT pg_advisory_unlock(74321101)');}finally{db.release();}}
}
const statusSchema=z.enum(['RECEIVED','VERIFYING','NEEDS_ACTION','REJECTED']);
export async function listSupportRequests(pool:pg.Pool,input:{status?:string;limit?:number}={}){
 if(input.status)statusSchema.parse(input.status);const limit=z.number().int().min(1).max(100).parse(input.limit??30);
 return rows(pool,`SELECT p.id,p.status,p.scope,p.type,p.requested_at,p.assigned_at,p.due_at,p.user_visible_note,p.version,a.details->>'operator' AS assigned_operator FROM privacy_requests p LEFT JOIN LATERAL(SELECT details FROM audit_logs WHERE source_id=p.id AND action='SUPPORT_REQUEST_UPDATED' ORDER BY created_at DESC,id DESC LIMIT 1)a ON true WHERE p.type='PIN_RECOVERY' AND ($1::text IS NULL OR p.status=$1) ORDER BY p.due_at,p.id LIMIT $2`,[input.status??null,limit]);
}
export async function showSupportRequest(pool:pg.Pool,requestId:string){
 z.string().uuid().parse(requestId);const p=await one(pool,`SELECT id,status,type,scope,confirmation,requested_at,assigned_at,due_at,user_visible_note,version FROM privacy_requests WHERE id=$1 AND type='PIN_RECOVERY'`,[requestId]);
 const redact=(value:any)=>typeof value==='string'?value.replace(/\b\d{6}\b/g,'[已隐藏六位敏感数字]').replace(/[A-F0-9]{5}(?:-[A-F0-9]{5}){5,}/gi,'[已隐藏恢复码]'):undefined;
 const {confirmation,...visible}=p;return{...visible,description:redact(confirmation?.description),contactChannel:redact(confirmation?.contactChannel)};
}
export async function updateSupportRequest(pool:pg.Pool,input:{requestId:string;status:string;expectedVersion:number;operator:string;note:string;evidenceReference?:string}){
 const b=z.object({requestId:z.string().uuid(),status:statusSchema,expectedVersion:z.number().int().positive(),operator:operatorSchema,note:z.string().trim().min(5).max(500),evidenceReference:z.string().trim().min(3).max(150).regex(/^[a-zA-Z0-9:/._-]+$/).optional()}).strict().parse(input);
 if(/\b\d{6}\b|[A-F0-9]{5}(?:-[A-F0-9]{5}){5,}/i.test(b.note))throw new Error('DO_NOT_RECORD_PIN_OR_RECOVERY_SECRETS');
 return transaction(pool,async db=>{
  const p=await one(db,'SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE',[b.requestId]);if(p.type!=='PIN_RECOVERY')throw new AppError(409,'SUPPORT_SCOPE_REQUIRED','此命令只受理PIN支持工单，不能代替导出/删除完成证明');if(p.version!==b.expectedVersion)throw new AppError(409,'VERSION_CONFLICT','工单已更新，请重新读取');
  const transitions:Record<string,string[]>={RECEIVED:['VERIFYING','NEEDS_ACTION','REJECTED'],VERIFYING:['VERIFYING','NEEDS_ACTION','REJECTED'],NEEDS_ACTION:['VERIFYING','NEEDS_ACTION','REJECTED'],REJECTED:[]};
  if(!transitions[p.status]?.includes(b.status))throw new AppError(409,'INVALID_STATE','不允许此工单状态变更');
  const updated=await one(db,`UPDATE privacy_requests SET status=$2,user_visible_note=$3,assigned_at=COALESCE(assigned_at,clock_timestamp()),completed_at=CASE WHEN $2='REJECTED' THEN clock_timestamp() ELSE completed_at END,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING id,type,scope,status,requested_at,assigned_at,due_at,completed_at,user_visible_note,version`,[p.id,b.status,b.note]);
  await audit(db,null,'SUPPORT_REQUEST_UPDATED',{sourceId:p.id,details:{operator:b.operator,previousStatus:p.status,status:b.status,evidenceReference:b.evidenceReference??null}});
  return{...updated,assignedOperator:b.operator,pinChanged:false};
 });
}
async function runCli(){
 const [command,...tokens]=process.argv.slice(2),args:Record<string,string>={};for(let i=0;i<tokens.length;i+=2){const key=tokens[i];if(!/^--[a-z-]+$/.test(key)||!tokens[i+1]||tokens[i+1].startsWith('--')||args[key])throw new Error('INVALID_CLI_ARGUMENTS');args[key]=tokens[i+1];}
 const allowed:Record<string,string[]>={'backup-check':['--config','--operator','--request-id'],'backup-confirm':['--config','--operator','--request-id'],'support-list':['--status','--limit'],'support-show':['--request-id'],'support-update':['--request-id','--status','--expected-version','--operator','--note-file','--evidence-reference']};
 if(!allowed[command]||Object.keys(args).some(a=>!allowed[command].includes(a)))throw new Error('Use backup-check, backup-confirm, support-list, support-show or support-update; see ops/PRIVACY.md');
 const databaseUrl=process.env.PRIVACY_DATABASE_URL||process.env.DATABASE_URL;if(!databaseUrl)throw new Error('PRIVACY_DATABASE_URL_REQUIRED');
 const environment=process.env.APP_ENV==='test'?'test':'production';if(environment==='production'&&new URL(databaseUrl).username!=='pointjoy_privacy')throw new Error('PRIVACY_DATABASE_ROLE_REQUIRED');
 const pool=new pg.Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000});try{
  let result:any;
  if(command.startsWith('backup-')){if(!args['--config']||!args['--operator'])throw new Error('CONFIG_AND_OPERATOR_REQUIRED');const filename=path.resolve(args['--config']),st=await fs.lstat(filename);if(!st.isFile()||st.isSymbolicLink()||environment==='production'&&(st.uid!==0||st.mode&0o022))throw new Error('UNTRUSTED_MAINTENANCE_CONFIG');const config=JSON.parse(await fs.readFile(filename,'utf8'));result=await confirmBackupPurge(pool,config,{environment,databaseUrl},args['--operator'],{dryRun:command==='backup-check',requestId:args['--request-id']});if(result.storageErrors.length||result.results.some((r:any)=>r.state==='PENDING'))process.exitCode=2;
  }else if(command==='support-list')result={items:await listSupportRequests(pool,{status:args['--status'],limit:args['--limit']?Number(args['--limit']):undefined})};
  else if(command==='support-show')result=await showSupportRequest(pool,args['--request-id']);
  else{if(!args['--note-file'])throw new Error('NOTE_FILE_REQUIRED');result=await updateSupportRequest(pool,{requestId:args['--request-id'],status:args['--status'],expectedVersion:Number(args['--expected-version']),operator:args['--operator'],note:await fs.readFile(path.resolve(args['--note-file']),'utf8'),evidenceReference:args['--evidence-reference']});}
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
 }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){runCli().catch((error:any)=>{process.stderr.write(JSON.stringify({error:error.code||error.name||'MAINTENANCE_FAILED',message:error.message})+'\n');process.exitCode=1;});}
