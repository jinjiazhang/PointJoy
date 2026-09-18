import { HttpException } from '@nestjs/common';

export async function exchangeCode(code: string, request: typeof fetch = fetch): Promise<string> {
 const appid=process.env.WECHAT_APP_ID, secret=process.env.WECHAT_APP_SECRET;
 if(!appid||!secret)throw new HttpException({code:'LOGIN_UNAVAILABLE',message:'微信登录尚未配置'},503);
 const url=new URL('https://api.weixin.qq.com/sns/jscode2session');
 url.search=new URLSearchParams({appid,secret,js_code:code,grant_type:'authorization_code'}).toString();
 let data:any;
 try {
  const response=await request(url,{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('upstream');
  data=await response.json();
 }catch{
  throw new HttpException({code:'LOGIN_UNAVAILABLE',message:'微信服务暂时不可用，请稍后重试'},503);
 }
 if(data.errcode||typeof data.openid!=='string'||!data.openid||data.openid.length>128){
  throw new HttpException({code:'WECHAT_LOGIN_FAILED',message:'微信登录未成功，请重新登录'},401);
 }
 return data.openid;
}
