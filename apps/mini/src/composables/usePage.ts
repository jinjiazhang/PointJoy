import {ref,onMounted,onUnmounted} from 'vue'
import {ApiError,errorText} from '../services/api'
import {go} from '../services/navigation'
import {useSession} from '../stores/session'
export function usePage(name:string,load:()=>Promise<void>,kind:'public'|'account'|'guardian'|'child'|'authenticated'='authenticated'){
 const loading=ref(false),error=ref(''),busy=ref(false);const session=useSession();let seq=0
 async function reload(){const id=++seq;loading.value=true;error.value='';try{if(!await session.guard(kind))return;await load()}catch(e){if(id===seq)error.value=errorText(e)}finally{if(id===seq)loading.value=false;uni.stopPullDownRefresh()}}
 async function act(fn:()=>Promise<unknown>,success?:string){if(busy.value)return;busy.value=true;error.value='';try{await fn();if(success)uni.showToast({title:success,icon:'none'});return true}catch(e){error.value=errorText(e);if(e instanceof ApiError){if(e.code==='OPERATION_IN_PROGRESS')go('recovery');else if(e.code==='PROFILE_REQUIRED')go('profile',{},true);else if(['PIN_REQUIRED','PIN_RECOVERY_REQUIRED'].includes(e.code))go('pin',{purpose:session.isDelegated?'exit':'unlock'});else if(e.status===401)go('login',{},true)}return false}finally{busy.value=false}}
 const visible=(route:string)=>{if(route===name)void reload()};onMounted(()=>{uni.$on('page:visible',visible);void reload()});onUnmounted(()=>{seq++;uni.$off('page:visible',visible)});return{loading,error,busy,reload,act,session}
}
