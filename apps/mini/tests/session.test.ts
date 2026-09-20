import test,{beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createPinia,setActivePinia} from 'pinia'
import {useSession} from '../src/stores/session'
import {loadAuth,saveAuth} from '../src/services/vault'
import type {SessionView,Tokens} from '../src/services/types'
const storage=new Map<string,unknown>(),listeners=new Map<string,Function[]>()
let calls:string[]=[],routes:string[]=[],offline=false
const tokens=(mode:SessionView['mode']='GUARDIAN',familyId='family-A'):Tokens=>({accessToken:'access',refreshToken:'refresh',expiresIn:900,session:{sessionId:'session-A',mode,familyId,actorScopeKey:mode+'-'+familyId,accountScopeKey:'account-A',capabilities:[]}})
;(globalThis as any).uni={
 getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,JSON.parse(JSON.stringify(value))),removeStorageSync:(key:string)=>storage.delete(key),
 $on:(event:string,fn:Function)=>listeners.set(event,[...(listeners.get(event)||[]),fn]),$emit:(event:string,payload:unknown)=>listeners.get(event)?.forEach(fn=>fn(payload)),
 reLaunch:({url}:{url:string})=>routes.push(url),navigateTo:({url}:{url:string})=>routes.push(url),
 request:(req:any)=>{const path=new URL(req.url).pathname.replace('/api/v1','');calls.push(path);if(offline){req.fail({});return}const data=path==='/auth/session'?loadAuth()!.session:path==='/auth/context'?tokens('GUARDIAN',req.data.contextId):path==='/me/profile'?{id:'parent',displayName:'妈妈'}:path.startsWith('/families/')?{family:{id:loadAuth()!.session.familyId,name:'向日葵之家'},membership:{role:'OWNER'},childrenSummary:[]}:{};req.success({statusCode:200,data:{data}})}
}
setActivePinia(createPinia())
const session=useSession()
beforeEach(()=>{storage.clear();calls=[];routes=[];offline=false;session.$reset()})
test('first launch without credentials stays on onboarding without requesting a session',async()=>{assert.equal(await session.resume(),false);assert.deepEqual(calls,[]);assert.deepEqual(routes,[])})
test('cold launch restores the saved family without login or context selection',async()=>{saveAuth(tokens());session.$reset();assert.equal(await session.resume(),true);assert.deepEqual(routes,['/pages/guardian/home']);assert.equal(session.family?.family.id,'family-A');assert.deepEqual(calls,['/auth/session','/me/profile','/families/family-A'])})
test('switching families persists the choice across a fresh store state',async()=>{saveAuth(tokens());await session.selectContext('family-B');session.$reset();routes=[];calls=[];assert.equal(await session.resume(),true);assert.equal(session.view?.familyId,'family-B');assert.deepEqual(routes,['/pages/guardian/home']);assert.ok(!calls.includes('/auth/context'))})
test('delegated child mode resumes without opening the parent account',async()=>{const child=tokens('CHILD');child.session.childSessionSource='DELEGATED';child.session.childId='child-A';saveAuth(child);await session.resume();assert.deepEqual(routes,['/pages/child/today']);assert.deepEqual(calls,['/auth/session'])})
test('incomplete onboarding and locked sessions still route to the required step',async()=>{for(const [mode,path] of [['PROFILE_ONLY','/pages/auth/profile'],['ACCOUNT','/pages/auth/contexts'],['LOCKED','/pages/auth/pin?purpose=unlock']] as const){saveAuth(tokens(mode));routes=[];await session.resume();assert.deepEqual(routes,[path])}})
test('temporary startup failures retain credentials and allow retrying the same family',async()=>{saveAuth(tokens());offline=true;await assert.rejects(session.resume(),/网络/);assert.ok(loadAuth());assert.deepEqual(routes,[]);offline=false;await session.resume();assert.deepEqual(routes,['/pages/guardian/home'])})
test('explicit logout clears restoration so the next launch requires login',async()=>{saveAuth(tokens());await session.logout();routes=[];assert.equal(await session.resume(),false);assert.equal(loadAuth(),null);assert.deepEqual(routes,[])})
