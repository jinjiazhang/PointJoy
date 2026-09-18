import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { execFileSync,spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
const root=process.cwd(),database='pointjoy_test_'+Date.now();
const databaseUrl=`postgresql://pointjoy:pointjoy_local_only@localhost:55432/${database}?schema=public`;
const env={...process.env,DATABASE_URL:databaseUrl,PORT:'4101',HOST:'127.0.0.1',NODE_ENV:'test',DEMO_AUTH:'true',OPERATION_KEY:randomBytes(32).toString('hex')};
const base='http://127.0.0.1:4101/api/v1';
let server,sql,tokens,users,logs='';
async function req(user,route,body,method=body===undefined?'GET':'POST',key=randomUUID()){
 const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(user!==null?{Authorization:'Bearer '+tokens[user]}:{}),'Idempotency-Key':key},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const json=await r.json();return {status:r.status,...json};
}
async function ok(user,route,body,method,key){const r=await req(user,route,body,method,key);assert.equal(r.status,200,JSON.stringify(r)+(r.status===500?logs.slice(-3500):''));return r.data;}
async function group(){return (await ok(0,'/groups',{name:'自动化验证群',description:'独立测试库'})).group.id;}
async function join(gid,user=1){const i=await ok(0,`/groups/${gid}/invitations`,{});const a=await ok(user,'/join-applications',{code:i.code});await ok(0,`/groups/${gid}/join-applications/${a.id}/decision`,{decision:'APPROVE'});return (await ok(user,`/groups/${gid}/dashboard`)).membership.id;}
async function grant(gid,mid,delta=100){return ok(0,`/groups/${gid}/point-entries`,{memberId:mid,type:'GRANT',delta,reason:'测试奖励'});}
async function reward(gid,cost=30,stock=3){let r=await ok(0,`/groups/${gid}/rewards`,{name:'测试奖励',type:'VIRTUAL',costPoints:cost,initialStock:stock,fulfillmentInstructions:'测试交付'});r=await ok(0,`/groups/${gid}/rewards/${r.id}/status`,{status:'ACTIVE',expectedVersion:r.version});return r;}
const purchase=(g,r)=>({route:`/groups/${g}/redemptions`,body:{rewardId:r.id,expectedRewardVersion:r.version,expectedCostPoints:r.costPoints}});
test('PointJoy real PostgreSQL integration',async t=>{
 execFileSync('docker',['compose','exec','-T','db','createdb','-U','pointjoy',database],{cwd:root});
 try{
  execFileSync(process.execPath,[path.join(root,'node_modules/prisma/build/index.js'),'migrate','deploy'],{cwd:path.join(root,'apps/api'),env,stdio:'pipe'});
  sql=new PrismaClient({datasources:{db:{url:databaseUrl}}});
  users=await Promise.all(['测试群主','测试成员','外群用户'].map(displayName=>sql.user.create({data:{displayName}})));
  server=spawn(process.execPath,['dist/main.js'],{cwd:path.join(root,'apps/api'),env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  for(let i=0;i<60;i++){if(server.exitCode!==null)throw new Error(logs);try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}await delay(100);if(i===59)throw new Error(logs);}
  tokens=[];for(const u of users){const r=await req(null,'/auth/demo',{userId:u.id});assert.equal(r.status,200);tokens.push(r.data.accessToken);}
  await t.test('profile edits are authenticated, scoped to current user and avatar images validated',async()=>{
   assert.equal((await req(null,'/me',{displayName:'匿名'},'PATCH')).status,401);
   assert.equal((await req(0,'/me',{displayName:'新昵称',userId:users[1].id},'PATCH')).status,400);
   const updated=await ok(0,'/me',{displayName:'微信昵称'},'PATCH');assert.equal(updated.displayName,'微信昵称');assert.equal(updated.wechatOpenId,undefined);
   assert.equal((await ok(1,'/me')).displayName,'测试成员');
   assert.equal((await req(0,'/me/avatar',{imageBase64:Buffer.from('<svg>bad</svg>').toString('base64')})).status,400);
   const sharp=(await import('sharp')).default;const data=await sharp({create:{width:4,height:4,channels:3,background:'#426ce0'}}).png().toBuffer();
   const key=randomUUID(),body={imageBase64:data.toString('base64')};const one=await ok(0,'/me/avatar',body,'POST',key),two=await ok(0,'/me/avatar',body,'POST',key);
   assert.equal(one.avatar,two.avatar);assert.match(one.avatar,/\/avatars\/[a-f0-9]{64}\.jpg$/);
   const response=await fetch(base+'/avatars/'+one.avatar.split('/').pop());assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');
   const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(metadata.width,256);assert.equal(metadata.height,256);
  });
  await t.test('task lifecycle, permissions, resubmission and concurrent approval award once',async()=>{
   const g=await group(),m=await join(g),m2=await join(g,2);const prefix='/groups/'+g;
   const spec={kind:'DAILY',title:'阅读30分钟',description:'完成阅读后填写收获',points:20};
   assert.equal((await req(1,prefix+'/activities',spec)).status,403);
   const task=await ok(0,prefix+'/activities',spec);
   const claim=await ok(1,prefix+'/activities/'+task.id+'/claim',{});
   assert.equal((await req(1,prefix+'/activities/'+task.id+'/claim',{})).error.code,'ALREADY_CLAIMED');
   assert.equal((await req(2,prefix+'/activity-claims/'+claim.id+'/submit',{submission:'冒用',expectedVersion:1})).status,403);
   let current=await ok(1,prefix+'/activity-claims/'+claim.id+'/submit',{submission:'读完第一章',expectedVersion:1});
   assert.equal((await req(1,prefix+'/activity-claims/'+claim.id+'/review',{decision:'APPROVE',reason:'',expectedVersion:current.version})).status,403);
   const foreign=await group();assert.equal((await req(0,'/groups/'+foreign+'/activity-claims/'+claim.id+'/review',{decision:'APPROVE',reason:'',expectedVersion:current.version})).status,404);
   const oldVersion=current.version;
   current=await ok(0,prefix+'/activity-claims/'+claim.id+'/review',{decision:'REJECT',reason:'请补充心得',expectedVersion:current.version});
   assert.equal((await ok(1,prefix+'/dashboard')).account.balance,0);
   current=await ok(1,prefix+'/activity-claims/'+claim.id+'/submit',{submission:'补充了阅读心得',expectedVersion:current.version});
   assert.equal((await req(0,prefix+'/activity-claims/'+claim.id+'/review',{decision:'APPROVE',reason:'',expectedVersion:oldVersion})).status,409);
   const body={decision:'APPROVE',reason:'完成得很好',expectedVersion:current.version};
   const results=await Promise.all([req(0,prefix+'/activity-claims/'+claim.id+'/review',body),req(0,prefix+'/activity-claims/'+claim.id+'/review',body)]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await ok(1,prefix+'/dashboard')).account.balance,20);
   assert.equal(await sql.ledger.count({where:{groupId:g,memberId:m}}),1);
   let own=await ok(0,prefix+'/activities/'+task.id+'/claim',{});own=await ok(0,prefix+'/activity-claims/'+own.id+'/submit',{submission:'我也完成了',expectedVersion:1});
   assert.equal((await req(0,prefix+'/activity-claims/'+own.id+'/review',{decision:'APPROVE',reason:'',expectedVersion:own.version})).error.code,'SELF_OPERATION_FORBIDDEN');
   let c2=await ok(2,prefix+'/activities/'+task.id+'/claim',{});await ok(0,prefix+'/activities/'+task.id+'/close',{});
   c2=await ok(2,prefix+'/activity-claims/'+c2.id+'/submit',{submission:'已领取仍可提交',expectedVersion:1});
   const capActivity=await ok(0,prefix+'/activities',{...spec,points:2000000000});
   c2=await ok(2,prefix+'/activities/'+capActivity.id+'/claim',{});
   c2=await ok(2,prefix+'/activity-claims/'+c2.id+'/submit',{submission:'测试积分上限',expectedVersion:1});
   await grant(g,m2,1);
   assert.equal((await req(0,prefix+'/activity-claims/'+c2.id+'/review',{decision:'APPROVE',reason:'',expectedVersion:c2.version})).error.code,'BALANCE_LIMIT_EXCEEDED');
   assert.equal((await sql.activityClaim.findUnique({where:{id:c2.id}})).status,'SUBMITTED');
   const another=await ok(0,prefix+'/activities',spec);await ok(0,prefix+'/activities/'+another.id+'/close',{});assert.equal((await req(1,prefix+'/activities/'+another.id+'/claim',{})).status,409);
   const memberView=await ok(1,prefix+'/dashboard');assert.ok(memberView.activityClaims.every(c=>c.memberId===m));
  });
  await t.test('daily periods and limited activity time windows are enforced by server',async()=>{
   const g=await group();await join(g);const prefix='/groups/'+g;
   const now=Date.now(),iso=n=>new Date(n).toISOString();
   const spec={title:'限时挑战',description:'活动规则',points:5,kind:'LIMITED'};
   assert.equal((await req(0,prefix+'/activities',spec)).status,400);
   assert.equal((await req(0,prefix+'/activities',{...spec,startsAt:iso(now+60000),endsAt:iso(now)})).status,400);
   const future=await ok(0,prefix+'/activities',{...spec,startsAt:iso(now+60000),endsAt:iso(now+3600000)});
   assert.equal((await req(1,prefix+'/activities/'+future.id+'/claim',{})).error.code,'ACTIVITY_UNAVAILABLE');
   const limited=await ok(0,prefix+'/activities',{...spec,startsAt:iso(now-60000),endsAt:iso(now+3600000)});
   const c=await ok(1,prefix+'/activities/'+limited.id+'/claim',{});assert.equal(c.period,'ONCE');
   await sql.activityClaim.update({where:{id:c.id},data:{expiresAt:new Date(now-1)}});
   assert.equal((await req(1,prefix+'/activity-claims/'+c.id+'/submit',{submission:'迟到',expectedVersion:1})).error.code,'ACTIVITY_EXPIRED');
   await sql.activity.update({where:{id:limited.id},data:{endsAt:new Date(now-1000)}});
   assert.equal((await req(0,prefix+'/activities/'+limited.id+'/claim',{})).error.code,'ACTIVITY_UNAVAILABLE');
   const daily=await ok(0,prefix+'/activities',{title:'日常阅读',description:'每天阅读',points:3,kind:'DAILY'});
   const day=await ok(1,prefix+'/activities/'+daily.id+'/claim',{});assert.match(day.period,/^\d{4}-\d{2}-\d{2}$/);assert.equal(new Date(day.expiresAt).getUTCHours(),16);
   await sql.activityClaim.update({where:{id:day.id},data:{period:'2000-01-01',expiresAt:new Date('2000-01-02T00:00:00+08:00')}});
   const again=await ok(1,prefix+'/activities/'+daily.id+'/claim',{});assert.notEqual(again.id,day.id);
   assert.equal((await req(1,prefix+'/activities/'+daily.id+'/claim',{})).error.code,'ALREADY_CLAIMED');
  });
  await t.test('admin progress separates kinds and dates, includes nonparticipants and does not truncate',async()=>{
   const g=await group(),member=await join(g),prefix='/groups/'+g;
   assert.equal((await req(1,prefix+'/activity-progress')).status,403);
   assert.equal((await req(2,prefix+'/activity-progress')).status,404);
   assert.equal((await req(0,prefix+'/activity-progress?date=2026-02-30')).status,400);
   const owner=await sql.member.findUnique({where:{groupId_userId:{groupId:g,userId:users[0].id}}});
   const ids=Array.from({length:205},()=>randomUUID());
   await sql.activity.createMany({data:ids.map(id=>({id,groupId:g,creatorMemberId:owner.id,title:'日常检查',description:'检查',points:1,kind:'DAILY'}))});
   const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
   await sql.activityClaim.createMany({data:ids.map(activityId=>({groupId:g,activityId,memberId:member,period:day,expiresAt:new Date(Date.now()+86400000)}))});
   const report=await ok(0,prefix+'/activity-progress?kind=DAILY&date='+day);
   assert.equal(report.activities.length,205);assert.equal(report.claims.length,205);assert.equal(report.members.length,2);assert.ok(report.claims.every(c=>c.memberId===member));
   const limited=await ok(0,prefix+'/activity-progress?kind=LIMITED');assert.equal(limited.activities.length,0);assert.equal(limited.claims.length,0);
   const old=await ok(0,prefix+'/activity-progress?kind=DAILY&date=2000-01-01');assert.equal(old.activities.length,0);assert.equal(old.members.length,0);assert.equal(old.claims.length,0);
  });
  let gid,mid,r,order;
  await t.test('one user creates many groups, isolated accounts and roles',async()=>{const before=(await ok(0,'/groups')).items.length;gid=await group();const second=await group();mid=await join(gid);await grant(gid,mid);const a=await ok(1,`/groups/${gid}/dashboard`);assert.equal(a.account.balance,100);assert.equal(a.membership.effectiveRole,'MEMBER');assert.equal((await ok(0,`/groups/${second}/dashboard`)).account.balance,0);assert.equal((await ok(0,'/groups')).items.length,before+2);});
  await t.test('authentication, group isolation and self-grant protection',async()=>{assert.equal((await req(null,'/groups')).status,401);assert.equal((await req(2,`/groups/${gid}/dashboard`)).status,404);assert.equal((await req(1,`/groups/${gid}/point-entries`,{memberId:mid,type:'GRANT',delta:5,reason:'越权'})).status,403);const own=(await ok(0,`/groups/${gid}/dashboard`)).membership.id;assert.equal((await req(0,`/groups/${gid}/point-entries`,{memberId:own,type:'GRANT',delta:5,reason:'自己发分'})).status,403);});
  await t.test('concurrent identical redemption creates one order and debit',async()=>{r=await reward(gid);const p=purchase(gid,r),key=randomUUID();const out=await Promise.all(Array.from({length:5},()=>req(1,p.route,p.body,'POST',key)));out.forEach(x=>assert.equal(x.status,200,JSON.stringify(x)));assert.equal(new Set(out.map(x=>x.data.order.id)).size,1);order=out[0].data.order;assert.equal((await ok(1,`/groups/${gid}/dashboard`)).account.balance,70);assert.equal(await sql.ledger.count({where:{orderId:order.id,type:'REDEEM'}}),1);assert.equal((await sql.reward.findUnique({where:{id:r.id}})).stockAvailable,2);const different=await req(1,p.route,{...p.body,expectedCostPoints:31},'POST',key);assert.equal(different.error.code,'IDEMPOTENCY_KEY_REUSED');});
  await t.test('cancel refunds exactly once, restores stock, leaves immutable ledger',async()=>{const route=`/groups/${gid}/redemptions/${order.id}/cancel`;await Promise.all([ok(1,route,{reason:'取消测试'}),ok(1,route,{reason:'取消测试'})]);assert.equal((await ok(1,`/groups/${gid}/dashboard`)).account.balance,100);assert.equal((await sql.reward.findUnique({where:{id:r.id}})).stockAvailable,3);assert.equal(await sql.ledger.count({where:{orderId:order.id,type:'REFUND'}}),1);await assert.rejects(sql.ledger.updateMany({where:{orderId:order.id},data:{reason:'篡改'}}));});
  await t.test('competing redemptions cannot oversell last item',async()=>{const last=await reward(gid,20,1);const p=purchase(gid,last);const out=await Promise.all([req(1,p.route,p.body),req(1,p.route,p.body)]);assert.deepEqual(out.map(x=>x.status).sort(),[200,409]);assert.equal((await sql.reward.findUnique({where:{id:last.id}})).stockAvailable,0);assert.equal((await ok(1,`/groups/${gid}/dashboard`)).account.balance,80);});
  await t.test('insufficient balance rolls back newly inserted order and inventory',async()=>{const expensive=await reward(gid,1000,1),p=purchase(gid,expensive);const before=await sql.redemption.count();const out=await req(1,p.route,p.body);assert.equal(out.error.code,'INSUFFICIENT_POINTS');assert.equal(await sql.redemption.count(),before);assert.equal((await sql.reward.findUnique({where:{id:expensive.id}})).stockAvailable,1);});
  await t.test('stale reward version rejected without charging',async()=>{const p=purchase(gid,r);await ok(0,`/groups/${gid}/rewards/${r.id}`,{name:r.name,description:'新说明',costPoints:31,fulfillmentInstructions:r.fulfillmentInstructions,expectedVersion:r.version},'PATCH');assert.equal((await req(1,p.route,p.body)).error.code,'REWARD_CHANGED');assert.equal((await ok(1,`/groups/${gid}/dashboard`)).account.balance,80);});
  await t.test('cross-group reward cannot be used',async()=>{const foreign=await group();const fr=await reward(foreign);const p=purchase(gid,fr);assert.equal((await req(1,p.route,p.body)).status,404);});
  await t.test('cancel and fulfillment serialize to a single terminal state',async()=>{const rr=await reward(gid,10),p=purchase(gid,rr);const o=(await ok(1,p.route,p.body)).order;assert.equal((await req(1,`/groups/${gid}/redemptions/${o.id}/fulfill`,{reason:'伪造核销'})).status,403);const results=await Promise.all([req(0,`/groups/${gid}/redemptions/${o.id}/fulfill`,{reason:'测试已交付'}),req(1,`/groups/${gid}/redemptions/${o.id}/cancel`,{reason:'测试取消'})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);const final=await sql.redemption.findUnique({where:{id:o.id}});assert.ok(['CANCELED','FULFILLED'].includes(final.status));assert.equal(await sql.ledger.count({where:{orderId:o.id,type:'REFUND'}}),final.status==='CANCELED'?1:0);});
  await t.test('role updates take effect and version collisions fail',async()=>{let m=await sql.member.findUnique({where:{id:mid}});await ok(0,`/groups/${gid}/members/${mid}/role`,{role:'ADMIN',expectedVersion:m.version},'PATCH');assert.equal((await ok(1,`/groups/${gid}/dashboard`)).admin,true);assert.equal((await req(0,`/groups/${gid}/members/${mid}/role`,{role:'MEMBER',expectedVersion:m.version},'PATCH')).error.code,'VERSION_CONFLICT');m=await sql.member.findUnique({where:{id:mid}});await ok(0,`/groups/${gid}/members/${mid}/role`,{role:'MEMBER',expectedVersion:m.version},'PATCH');assert.equal((await ok(1,`/groups/${gid}/dashboard`)).admin,false);});
  await t.test('reversals are single-use and retain original entries',async()=>{const e=(await grant(gid,mid,5)).entry;await ok(0,`/groups/${gid}/point-entries/${e.id}/reversal`,{reason:'错误发分'});assert.equal((await req(0,`/groups/${gid}/point-entries/${e.id}/reversal`,{reason:'再次冲正'})).error.code,'ALREADY_REVERSED');assert.ok(await sql.ledger.findUnique({where:{id:e.id}}));});
  await t.test('same account concurrent purchases cannot overspend',async()=>{const current=(await ok(1,`/groups/${gid}/dashboard`)).account.balance;const rr=await reward(gid,current-1,2),p=purchase(gid,rr);const results=await Promise.all([req(1,p.route,p.body),req(1,p.route,p.body)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal((await ok(1,`/groups/${gid}/dashboard`)).account.balance,1);});
  await t.test('all balances and inventory reconcile against append-only journals',async()=>{for(const a of await sql.account.findMany()){const x=await sql.ledger.aggregate({where:{groupId:a.groupId,memberId:a.memberId},_sum:{delta:true},_max:{accountVersion:true}});assert.equal(a.balance,x._sum.delta||0);assert.equal(a.version,x._max.accountVersion||0);}for(const rr of await sql.reward.findMany()){const x=await sql.stockEntry.aggregate({where:{rewardId:rr.id},_sum:{delta:true},_max:{stockVersion:true}});assert.equal(rr.stockAvailable,x._sum.delta||0);assert.equal(rr.stockVersion,x._max.stockVersion||0);}});
 }finally{
  if(server&&server.exitCode===null){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await ended;}
  if(sql)await sql.$disconnect();
  execFileSync('docker',['compose','exec','-T','db','dropdb','-U','pointjoy','--if-exists',database],{cwd:root});
 }
});
