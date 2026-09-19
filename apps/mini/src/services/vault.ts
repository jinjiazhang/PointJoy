import type { Tokens, SessionView } from './types'
const KEY = 'pointjoy.auth.v1'
export function loadAuth(): Tokens|null { try { return uni.getStorageSync(KEY) || null } catch { return null } }
export function saveAuth(tokens: Tokens) { uni.setStorageSync(KEY,tokens); uni.$emit('auth:changed',tokens.session) }
export function updateSession(session: SessionView) { const auth=loadAuth(); if(auth) saveAuth({...auth,session}) }
export function clearAuth() { uni.removeStorageSync(KEY); uni.$emit('auth:changed',null) }
export function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return(c==='x'?r:(r&3)|8).toString(16)}) }
