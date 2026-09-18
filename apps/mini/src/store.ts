import { defineStore } from 'pinia';
export function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)});}
export async function api(path:string,method='GET',body?:any,key?:string):Promise<any>{
 let base='/api/v1';
 // #ifdef MP-WEIXIN
 base=import.meta.env.VITE_API_BASE_URL||(import.meta.env.DEV?'http://127.0.0.1:4100/api/v1':'https://pointjoy.jinjiazh.com/api/v1');
 // #endif
 return new Promise((resolve,reject)=>uni.request({url:base+path,method:method as any,data:body,timeout:20000,header:{'Content-Type':'application/json',Authorization:'Bearer '+(uni.getStorageSync('pj-token')||''),...(key?{'Idempotency-Key':key}:{})},success:(r:any)=>{if(r.statusCode>=200&&r.statusCode<300)resolve(r.data.data);else reject(Object.assign(new Error(r.data?.error?.message||'服务暂时不可用'),{code:r.data?.error?.code,status:r.statusCode,uncertain:method!=='GET'&&r.statusCode>=500}));},fail:(err:any)=>{const detail=String(err?.errMsg||'未知网络错误');console.error('PointJoy request failed',{path,detail});const message=method==='GET'?'无法连接服务器，请重试':'网络连接中断，操作结果尚未确认，请重试';reject(Object.assign(new Error(message+'（'+detail+'）'),{uncertain:method!=='GET'}));}}));
}
export const useApp=defineStore('app',{
 state:()=>({authMode:'wechat',user:null as any,users:[] as any[],groups:[] as any[],gid:'',data:null as any,loading:false,error:'',epoch:0}),
 actions:{
  async init(){this.authMode=(await api('/auth/config')).mode;this.users=this.authMode==='demo'?await api('/auth/demo-users'):[];if(uni.getStorageSync('pj-token')){try{this.user=await api('/me');await this.loadGroups();}catch{uni.removeStorageSync('pj-token');this.user=null;}}},
  async login(user:any){this.epoch++;const r=await api('/auth/demo','POST',{userId:user.id});uni.setStorageSync('pj-token',r.accessToken);this.user=r.user;this.gid='';this.data=null;await this.loadGroups();},
  async loginWechat(){const result:any=await new Promise((resolve,reject)=>uni.login({provider:'weixin',success:resolve,fail:()=>reject(new Error('请在微信小程序中登录'))}));const r=await api('/auth/wechat','POST',{code:result.code});const saved=uni.getStorageSync('pj-pending');if(saved&&saved.userId!==r.user.id)throw new Error('请使用上次操作的微信账号登录');this.epoch++;uni.setStorageSync('pj-token',r.accessToken);this.user=r.user;this.gid='';this.data=null;await this.loadGroups();},
  async loadGroups(prefer?:string){const result=await api('/groups');this.groups=result.items;const saved=prefer||this.gid||uni.getStorageSync('pj-group:'+this.user.id);const found=this.groups.find((g:any)=>g.group.id===saved);if(found)await this.switchGroup(found.group.id);else if(this.groups.length===1)await this.switchGroup(this.groups[0].group.id);else{this.gid='';this.data=null;}},
  async switchGroup(gid:string){this.gid=gid;this.data=null;uni.setStorageSync('pj-group:'+this.user.id,gid);await this.refresh();},
  async refresh(){if(!this.gid)return;const gid=this.gid,epoch=++this.epoch;this.loading=true;this.error='';try{const d=await api('/groups/'+gid+'/dashboard');if(epoch===this.epoch&&gid===this.gid){this.data=d;const item=this.groups.find((x:any)=>x.group.id===gid);if(item){item.group=d.group;item.membership=d.membership;item.account=d.account;item.memberCount=d.memberCount;}}}catch(e:any){if(epoch===this.epoch)this.error=e.message;}finally{if(epoch===this.epoch)this.loading=false;}}
 }
});
