import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeCode } from '../apps/api/dist/wechat.js';

test('WeChat identity exchange validates provider responses without exposing secrets',async()=>{
 process.env.WECHAT_APP_ID='test-app';process.env.WECHAT_APP_SECRET='test-secret';
 const result=await exchangeCode('one-time-code',async url=>{
  assert.equal(url.hostname,'api.weixin.qq.com');
  assert.equal(url.searchParams.get('js_code'),'one-time-code');
  return Response.json({openid:'verified-user',session_key:'must-not-return'});
 });
 assert.equal(result,'verified-user');
 for(const body of [{errcode:40029,errmsg:'invalid code'},{openid:''},{openid:'x',errcode:40125},{}]){
  await assert.rejects(exchangeCode('bad',async()=>Response.json(body)),e=>e.getStatus()===401);
 }
 await assert.rejects(exchangeCode('code',async()=>{throw new Error('secret URL');}),e=>e.getStatus()===503&&!e.message.includes('secret'));
 delete process.env.WECHAT_APP_SECRET;
 await assert.rejects(exchangeCode('code'),e=>e.getStatus()===503);
});
