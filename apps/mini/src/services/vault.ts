import type { Tokens, SessionView } from './types'
const KEY = 'pointjoy.auth.v1'
const REFRESH_ATTEMPT = 'pointjoy.auth.refresh-attempt.v1'
export function loadAuth(): Tokens|null { try { return uni.getStorageSync(KEY) || null } catch { return null } }
export function saveAuth(tokens: Tokens) { if(loadAuth()?.refreshToken!==tokens.refreshToken)uni.removeStorageSync(REFRESH_ATTEMPT);uni.setStorageSync(KEY,tokens); uni.$emit('auth:changed',tokens.session) }
export function updateSession(session: SessionView) { const auth=loadAuth(); if(auth) saveAuth({...auth,session}) }
export function clearAuth() { uni.removeStorageSync(KEY);uni.removeStorageSync(REFRESH_ATTEMPT); uni.$emit('auth:changed',null) }
// Reuse the attempt after a lost response so the server can replay its rotated tokens.
export function refreshAttemptId() { const saved=uni.getStorageSync(REFRESH_ATTEMPT);if(saved)return String(saved);const id=uuid();uni.setStorageSync(REFRESH_ATTEMPT,id);return id }
export function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return(c==='x'?r:(r&3)|8).toString(16)}) }
