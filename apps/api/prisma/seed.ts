import 'dotenv/config';
import { db, createGroup, points, stock, redeem, audit } from '../src/domain';
async function main(){
 if(await db.user.count()){console.log('Seed skipped: existing data preserved.');return;}
 await db.$transaction(async tx=>{
  const users=[];
  for(const [displayName,avatar] of [['林小满','blue'],['陈一诺','peach'],['周予安','green'],['许星河','purple']])users.push(await tx.user.create({data:{displayName,avatar}}));
  const g1=await createGroup(tx,users[0].id,'周末成长小队','把小目标变成好习惯，把平凡日子过得闪闪发光。','blue');
  const g2=await createGroup(tx,users[1].id,'读书充电站','一起读书，一起遇见更大的世界。','green');
  const g3=await createGroup(tx,users[2].id,'一起动起来','运动不必很厉害，坚持就很可爱。','peach');
  const add=async(gid:string,uid:string,role='MEMBER')=>{const m=await tx.member.create({data:{groupId:gid,userId:uid,role}});await tx.account.create({data:{groupId:gid,memberId:m.id}});return m;};
  const m12=await add(g1.group.id,users[1].id,'ADMIN'),m13=await add(g1.group.id,users[2].id);
  const m21=await add(g2.group.id,users[0].id),m31=await add(g3.group.id,users[0].id,'ADMIN');
  for(const [delta,why] of [[120,'完成本周成长计划'],[80,'连续阅读四天'],[68,'帮助伙伴完成挑战'],[30,'认真整理自己的小空间']] as const)await points(tx,g1.group.id,g1.membership.id,m12.id,delta,'GRANT',why);
  await points(tx,g1.group.id,m12.id,g1.membership.id,150,'GRANT','一起认真生活');
  await points(tx,g1.group.id,m13.id,g1.membership.id,90,'GRANT','坚持运动三天');
  await points(tx,g2.group.id,m21.id,g2.membership.id,86,'GRANT','完成第一本共读书');
  await points(tx,g3.group.id,m31.id,g3.membership.id,140,'GRANT','本月运动目标达成');
  const definitions=[
   ['一杯喜欢的咖啡','忙碌的日子，也别忘了好好犒劳自己。','coffee','PHYSICAL',60,12,'联系管理员，领取一杯喜欢的咖啡'],
   ['自由游戏 30 分钟','放下待办，给快乐留一点时间。','game','VIRTUAL',30,20,'与管理员约定时间后享受 30 分钟游戏时光'],
   ['一本心愿清单里的书','翻开新的一页，也打开新的世界。','book','PHYSICAL',120,5,'告诉管理员书名，准备好后线下领取'],
   ['一盆桌面小绿植','让一点绿色，陪伴每一天的成长。','plant','PHYSICAL',90,8,'向管理员领取一盆桌面绿植'],
   ['周末电影选择权','这一次，由你决定大家看什么。','movie','VIRTUAL',100,3,'和伙伴约好时间，由你选择周末电影']
  ];
  for(const g of [g1,g2,g3])for(const v of definitions){
   let r=await tx.reward.create({data:{groupId:g.group.id,name:String(v[0]),description:String(v[1]),art:String(v[2]),type:String(v[3]),costPoints:Number(v[4]),fulfillmentInstructions:String(v[6]),status:'ACTIVE'}});
   r=await stock(tx,r,g.membership.id,Number(v[5]),'INITIAL','初始奖励库存');
   if(g===g1&&r.art==='game')await redeem(tx,users[0].id,g.group.id,{rewardId:r.id,expectedRewardVersion:r.version,expectedCostPoints:r.costPoints});
  }
  await audit(tx,g1.group.id,m12.id,'GRANT',g1.membership.id,'完成本周成长计划');
 },{timeout:20000});
 console.log('Seeded four demo identities and three independent groups.');
}
main().finally(()=>db.$disconnect());
