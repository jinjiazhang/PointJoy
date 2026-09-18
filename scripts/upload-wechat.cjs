// Install uploader separately: npm install --prefix work/wechat-ci miniprogram-ci
const path=require('node:path');
const ci=require('../work/wechat-ci/node_modules/miniprogram-ci');
const root=path.resolve(__dirname,'..');
const project=new ci.Project({appid:'wx5c24ed9df4175b79',type:'miniProgram',projectPath:path.join(root,'apps/mini/dist/build/mp-weixin'),privateKeyPath:process.env.WECHAT_UPLOAD_KEY_PATH||path.join(root,'private.wx5c24ed9df4175b79.key'),ignores:['node_modules/**/*']});
ci.upload({project,version:process.env.WECHAT_VERSION||'0.1.0',desc:process.env.WECHAT_DESC||'积乐圈：日常与限时活动、积分与奖励兑换',setting:{es6:true,minify:true},onProgressUpdate:()=>{}}).then(result=>{console.log('Upload complete',JSON.stringify(result));process.exit(0);}).catch(error=>{console.error('Upload failed:',error.message||String(error));process.exit(1);});
