const path = require('node:path');
const fs = require('node:fs');
const ci = require('../work/wechat-ci/node_modules/miniprogram-ci');
const root = path.resolve(__dirname, '..');
const version =
  process.env.WECHAT_VERSION ||
  JSON.parse(fs.readFileSync(path.join(root, 'apps/mini/src/manifest.json'), 'utf8')).versionName;
const build = path.join(root, 'apps/mini/dist/build/mp-weixin');
if (!fs.existsSync(path.join(build, 'app.json'))) {
  throw new Error('Build mp-weixin before uploading');
}
const project = new ci.Project({
  appid: 'wx5c24ed9df4175b79',
  type: 'miniProgram',
  projectPath: build,
  privateKeyPath:
    process.env.WECHAT_UPLOAD_KEY_PATH || path.join(root, 'private.wx5c24ed9df4175b79.key'),
  ignores: ['node_modules/**/*'],
});
const desc =
  process.env.WECHAT_DESC || '家庭版重建：微信身份、孩子活动照片、积分预留与奖励审批兑现';
const action = process.argv.includes('--preview') ? 'preview' : 'upload';
const opts = {
  project,
  version,
  desc,
  setting: { es6: true, minify: true, codeProtect: true },
  onProgressUpdate: () => {},
  ...(action === 'preview'
    ? {
        qrcodeFormat: 'image',
        qrcodeOutputDest: path.join(root, 'work', 'wechat-preview.jpg'),
        pagePath: 'pages/auth/login',
      }
    : {}),
};
ci[action](opts)
  .then((result) => {
    fs.mkdirSync(path.join(root, 'work'), { recursive: true });
    const record = { action, version, uploadedAt: new Date().toISOString(), result };
    fs.writeFileSync(
      path.join(root, 'work', `wechat-${action}-result.json`),
      JSON.stringify(record, null, 2),
    );
    console.log(
      JSON.stringify(
        { action, version, success: true, subPackageInfo: result.subPackageInfo },
        null,
        2,
      ),
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error('WeChat operation failed:', error.message || String(error));
    process.exit(1);
  });
