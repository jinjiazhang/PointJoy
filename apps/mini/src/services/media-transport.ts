import {API_BASE,ApiError} from './api'
import {uuid} from './vault'
import type {UploadIntent,UploadItem} from './types'

const MAX_BYTES=10*1024*1024
const extensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}
function ascii(text:string){const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes}
export function encodeMultipartImage(bytes:ArrayBuffer,mime:string,boundary:string):ArrayBuffer{
 if(!extensions[mime]||!/^[A-Za-z0-9-]{1,70}$/.test(boundary))throw new ApiError('UPLOAD_PROTOCOL_ERROR','图片保存协议不匹配，请更新小程序')
 if(!bytes.byteLength||bytes.byteLength>MAX_BYTES)throw new ApiError('MEDIA_TOO_LARGE','每张图片不能超过 10 MiB')
 const head=ascii(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${extensions[mime]}"\r\nContent-Type: ${mime}\r\n\r\n`)
 const tail=ascii(`\r\n--${boundary}--\r\n`),body=new Uint8Array(head.length+bytes.byteLength+tail.length)
 body.set(head);body.set(new Uint8Array(bytes),head.length);body.set(tail,head.length+bytes.byteLength);return body.buffer
}
function networkError(error:{errMsg?:string}){
 const message=error?.errMsg||''
 if(/url not in domain list|domain.*not.*(allow|list)|合法域名/i.test(message))return new ApiError('MEDIA_DOMAIN_NOT_ALLOWED','图片服务连接配置异常，请稍后重试')
 if(/ssl|certificate|tls/i.test(message))return new ApiError('MEDIA_TLS_FAILED','无法安全连接图片服务，请检查网络后重试')
 if(/timeout/i.test(message))return new ApiError('MEDIA_TIMEOUT','图片保存超时，请保持小程序在前台后重试')
 return new ApiError('MEDIA_NETWORK_FAILED','图片保存连接中断，请检查网络后重试')
}
function verifyResponse(status:number,raw:unknown,mediaId:string){
 let body=raw as any;if(typeof raw==='string'){try{body=JSON.parse(raw)}catch{body=null}}
 if(status>=200&&status<300&&body?.data?.uploaded===true&&body.data.mediaId===mediaId&&!body.error)return
 if(status===410)throw new ApiError('UPLOAD_EXPIRED','这次图片选择已过期，请重新选择',{},status)
 if(status===413)throw new ApiError('MEDIA_TOO_LARGE','每张图片不能超过 10 MiB',{},status)
 if(status===401||status===403)throw new ApiError('MEDIA_SESSION_EXPIRED','登录状态已变化，请重新登录后选择图片',{},status)
 throw new ApiError('MEDIA_SAVE_FAILED','图片保存未完成，请重试',{},status)
}
export async function sendImageFile(intent:UploadIntent,item:UploadItem,mime:string,expectedSize:number):Promise<void>{
 const prefix=API_BASE+'/media/uploads/'
 if(intent.uploadMethod!=='POST'||!intent.uploadUrl.startsWith(prefix)||!/^[A-Za-z0-9_-]{30,100}$/.test(intent.uploadUrl.slice(prefix.length))||(intent.formFieldName||'file')!=='file'||Object.keys(intent.formData||{}).length||!extensions[mime])throw new ApiError('UPLOAD_PROTOCOL_ERROR','图片保存协议不匹配，请更新小程序')
 if(!Number.isSafeInteger(expectedSize)||expectedSize<=0||expectedSize>MAX_BYTES)throw new ApiError('MEDIA_TOO_LARGE','每张图片不能超过 10 MiB')
 if(!item.localPath)throw new ApiError('MEDIA_LOCAL_MISSING','请重新选择图片')
 const manager=typeof uni.getFileSystemManager==='function'?uni.getFileSystemManager():undefined
 if(manager&&typeof manager.readFile==='function'){
  const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>manager.readFile({filePath:item.localPath!,success:r=>r.data instanceof ArrayBuffer?resolve(r.data):reject(new ApiError('MEDIA_LOCAL_UNREADABLE','图片无法读取，请重新选择')),fail:()=>reject(new ApiError('MEDIA_LOCAL_UNREADABLE','图片无法读取，请重新选择'))}))
  if(bytes.byteLength!==expectedSize)throw new ApiError('MEDIA_SIZE_MISMATCH','图片内容已变化，请重新选择')
  const boundary='PointJoy'+uuid().replace(/-/g,''),data=encodeMultipartImage(bytes,mime,boundary)
  await new Promise<void>((resolve,reject)=>uni.request({url:intent.uploadUrl,method:'POST',data,header:{...intent.requiredHeaders,'Content-Type':`multipart/form-data; boundary=${boundary}`},timeout:60000,success:r=>{try{verifyResponse(r.statusCode,r.data,intent.mediaId);resolve()}catch(e){reject(e)}},fail:e=>reject(networkError(e))}))
 }else{
  await new Promise<void>((resolve,reject)=>{const task=uni.uploadFile({url:intent.uploadUrl,filePath:item.localPath!,name:'file',formData:{},header:intent.requiredHeaders||{},timeout:60000,success:r=>{try{verifyResponse(r.statusCode,r.data,intent.mediaId);resolve()}catch(e){reject(e)}},fail:e=>reject(networkError(e))});task.onProgressUpdate(r=>{item.progress=r.progress})})
 }
 item.progress=100
}
