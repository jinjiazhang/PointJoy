import { defineStore } from 'pinia';
export function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16)});}
export async function api(path:string,method='GET',body?:any,key?:string):Promise<any>{
 let base='/api/v1';
 // #ifdef MP-WEIXIN
 base='http://127.0.0.1:4100/api/v1';
 // #endif
 return new Promise((resolve,reject)=>uni.request({url:base+path,method:method as any,data:body,timeout:20000,header:{'Content-Type':'application/json',Authorization:'Bearer '+(uni.getStorageSync('pj-token')||''),...(key?{'Idempotency-Key':key}:{})},success:(r:any)=>{if(r.statusCode>=200&&r.statusCode<300)resolve(r.data.data);else reject(Object.assign(new Error(r.data?.error?.message||'服务暂时不可用'),{code:r.data?.error?.code,status:r.statusCode,uncertain:method!=='GET'&&r.statusCode>=500}));},fail:()=>reject(Object.assign(new Error('网络连接中断，操作结果尚未确认，请重试'),{uncertain:method!=='GET'}))}));
}
export const useApp=defineStore('app',{
 state:()=>({user:null as any,users:[] as any[],groups:[] as any[],gid:'',data:null as any,loading:false,error:'',epoch:0}),
 actions:{
  async init(){this.users=await api('/auth/demo-users');if(uni.getStorageSync('pj-token')){try{this.user=await api('/me');await this.loadGroups();}catch{uni.removeStorageSync('pj-token');this.user=null;}}},
  async login(user:any){this.epoch++;const r=await api('/auth/demo','POST',{userId:user.id});uni.setStorageSync('pj-token',r.accessToken);this.user=r.user;this.gid='';this.data=null;await this.loadGroups();},
  async loadGroups(prefer?:string){const result=await api('/groups');this.groups=result.items;const saved=prefer||this.gid||uni.getStorageSync('pj-group:'+this.user.id);const found=this.groups.find((g:any)=>g.group.id===saved);if(found)await this.switchGroup(found.group.id);else if(this.groups.length===1)await this.switchGroup(this.groups[0].group.id);else{this.gid='';this.data=null;}},
  async switchGroup(gid:string){this.gid=gid;this.data=null;uni.setStorageSync('pj-group:'+this.user.id,gid);await this.refresh();},
  async refresh(){if(!this.gid)return;const gid=this.gid,epoch=++this.epoch;this.loading=true;this.error='';try{const d=await api('/groups/'+gid+'/dashboard');if(epoch===this.epoch&&gid===this.gid){this.data=d;const item=this.groups.find((x:any)=>x.group.id===gid);if(item){item.group=d.group;item.membership=d.membership;item.account=d.account;item.memberCount=d.memberCount;}}}catch(e:any){if(epoch===this.epoch)this.error=e.message;}finally{if(epoch===this.epoch)this.loading=false;}}
 }
});
