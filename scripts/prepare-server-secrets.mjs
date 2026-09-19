// Private deployment credentials are generated only in ignored work/ and never printed.
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
const values=Object.fromEntries(fs.readFileSync('pointjoy.yaml','utf8').split(/\r?\n/).filter(l=>/^[a-z_]+\s*:/.test(l)).map(l=>{const i=l.indexOf(':');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}));
if(values.app_id!=='wx5c24ed9df4175b79'||!values.app_secret||values.app_secret.length<24)throw new Error('Invalid WeChat configuration');
const dir='work/production-secrets';fs.mkdirSync(dir,{recursive:true,mode:0o700});
if(fs.existsSync(dir+'/api.env'))throw new Error('Existing prepared secrets preserved; do not regenerate deployed credentials');
const random=()=>randomBytes(32).toString('hex'),appPass=random(),workerPass=random(),migrationPass=random();
const common={APP_ENV:'production',NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4100',API_BASE_URL:'https://pointjoy.jinjiazh.com/api/v1',WECHAT_APP_ID:values.app_id,WECHAT_APP_SECRET:values.app_secret,SESSION_SIGNING_KEY:random(),RESPONSE_ENCRYPTION_KEY:random(),SECURITY_JOURNAL_KEY:random(),MEDIA_DIR:'/var/lib/pointjoy/media',EXPORT_DIR:'/var/lib/pointjoy/exports',SECURITY_JOURNAL_DIR:'/var/lib/pointjoy-recovery',SUPPORT_CONTACT:'https://github.com/jinjiazhang/PointJoy/issues'};
const write=(name,data)=>fs.writeFileSync(dir+'/'+name,data,{mode:0o600});const env=(role,pass)=>Object.entries({...common,DATABASE_URL:`postgresql://${role}:${pass}@127.0.0.1:5432/pointjoy`}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
write('api.env',env('pointjoy_app',appPass));write('worker.env',env('pointjoy_privacy',workerPass));write('migrate.env',env('pointjoy_migrate',migrationPass));write('backup.key',random()+'\n');write('backup.env','# PointJoy encrypted backup configuration\n');
write('roles.sql',`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pointjoy_migrate') THEN CREATE ROLE pointjoy_migrate LOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pointjoy_app') THEN CREATE ROLE pointjoy_app LOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pointjoy_privacy') THEN CREATE ROLE pointjoy_privacy LOGIN; END IF; END $$;\nALTER ROLE pointjoy_migrate WITH PASSWORD '${migrationPass}';\nALTER ROLE pointjoy_app WITH PASSWORD '${appPass}';\nALTER ROLE pointjoy_privacy WITH PASSWORD '${workerPass}';\nGRANT pointjoy_app TO pointjoy_privacy;\n`);
console.log('Prepared private environment files in ignored work/production-secrets');
