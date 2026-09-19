# 积乐圈微信小程序

基于 `docs/family-redesign-v1` 的 P0 实现。uni-app + Vue 3 + TypeScript + Pinia，32 个注册页面，生产仅微信登录，资料门禁要求服务端处理成功的真实上传头像和昵称。

1.1.1 的登录、家长和孩子页面采用 iOS 27 启发的顶部玻璃质感导航、浅色内容卡片及分组表单。底部标签栏全宽白底、贴底固定，顶部细分隔线，不设外边距、圆角或阴影；选中图标与文字为蓝色，白底延续至底部安全区。实现范围见 [界面说明](../../docs/mini-ui-v1.1.md)。共享图标为自制 PNG，可运行 `node scripts/generate-ui-icons.mjs` 重新生成（从仓库根目录执行）。兑换浮层内显示操作失败原因；无上一页时，返回当前身份的首页；积分账本默认直接加载积分明细。

## 运行

从仓库根目录先安装工作区依赖（根 `package-lock.json` 为准）。

```sh
npm run dev:mp-weixin --workspace=@pointjoy/mini
npm run build:mp-weixin --workspace=@pointjoy/mini
npm run typecheck --workspace=@pointjoy/mini
npm run test --workspace=@pointjoy/mini
```

微信开发者工具导入 `apps/mini/dist/build/mp-weixin`。AppID 已配置；AppSecret 和代码上传私钥只能在服务端或部署环境，不能放入这里。

本地 H5 使用独立本地 API：

```sh
VITE_LOCAL_AUTH=true VITE_API_BASE_URL=http://127.0.0.1:4100/api/v1 npm run dev:h5 --workspace=@pointjoy/mini
```

本地 API 必须是 `APP_ENV=local`，并运行图片处理 worker。联调输入例如 `local:ui-parent`。此输入仅 H5 开发编译出现，微信包不包含；H5 生产也没有模拟登录。

完整真实 HTTP 流程测试（仅允许 localhost，创建隔离测试身份及家庭）：

```sh
npm run test:integration --workspace=@pointjoy/mini
```

测试使用 `tests/fixtures/avatar.png` 的自制几何测试图片，没有真实个人资料。

## 页面与实现位置

- `src/features/AuthScreen.vue`：微信登录、必填资料、本人家庭上下文、邀请申请、PIN/恢复/支持、未明操作恢复、账号及隐私/删除后匿名回执。
- `ActivityScreen.vue`：家长首页/待办、计划草稿发布/版本/暂停恢复/挑战停止、孩子今日、完成照片/草稿/提交/代录补记/审核。
- `RewardScreen.vue`：奖励及库存、心愿、申请预留、家长审批、取消返还、实际兑现。
- `FamilyScreen.vue`：孩子档案头像、家庭邀请及申请、孩子账号绑定/解绑、负责人转让、成员退出/移除、归档。
- `RecordsScreen.vue`：积分流水、手动表扬、完整纠错、完成/兑换/操作历史、个人成长。
- `src/services/api.ts`：统一响应、单次刷新、幂等写入及原操作恢复、身份作用域隔离。
- `src/services/media.ts`：真实 multipart 上传、处理状态、范围限制及私有短时图片代理。

所有 PATCH 通过 `POST + X-HTTP-Method-Override: PATCH` 传输，服务器仅允许这一组合，幂等记录使用业务方法 PATCH。不能移除此适配：微信原生请求不提供 PATCH。

完成数量与文字的未同步输入按身份及实例隔离保存在本机24小时；显式保存草稿写服务器。图片选中即开始真实上传，服务端草稿照片24小时、正式提交照片首次提交后180天。身份变更时清私有图片缓存，旧家庭的迟到响应不会渲染。

首次确认数据处理申请时，最少状态回执独立保存，不随注销清除；在线删除完成和最多35天备份轮换清理分开显示。导出 ZIP 通过微信文件保存/分享选择器交给用户操作。

## 微信头像和昵称（1.0.1）

首次资料页和“我的账号”均支持微信原生头像选择，回调中的临时图片走现有上传、图片处理和 READY 校验。取消选择保留当前头像；低版本微信可继续从相册选择或拍照。家长为孩子建立的档案仍由家长填写，不自动复制家长微信资料。

昵称使用 `type="nickname"`，点击后可选微信推荐昵称，也可手动输入。输入框和提交按钮位于同一原生 form，通过提交事件取最终值，并处理 blur 同步、昵称检查失败和超时。资料门禁仍要求有效昵称和上传成功的头像。

资料页主动查询微信隐私授权；需要同意时展示平台隐私指引和原生同意按钮，确认后再启用头像与昵称。微信后台必须声明头像、昵称用途；当前工具未核验该 AppID 的后台声明和真机输入法行为。参考[微信头像昵称填写](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)及[隐私授权接入指南](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)。

1.0.2 修正了图片保存通道：微信端读取已选临时文件的原始二进制，通过 `uni.request` 向同一 API 的受限上传地址发送 multipart，沿用短时令牌、大小/身份校验和服务端图片处理。H5 仍使用文件上传接口。不会把本地临时路径当永久头像，也不会让用户在选择微信头像后再上传一次。界面显示“正在保存头像”，相册与拍照收在“使用其他头像”中。网络失败、超时、凭证过期分别提示，不输出私有路径或令牌；不自动重发结果不明的字节请求。

新增 21 项图片传输测试，验证真实 multipart 解析、二进制完整性、10 MiB 边界、受限地址、响应校验与失败分支；现有完整 HTTP 联调也改为使用同一 multipart 编码器，验证头像、孩子头像和活动照片的实际保存与后续业务流程。

## 已验证

- 类型检查、H5 生产编译、微信小程序生产编译。
- 运输测试：PATCH、未明写入沿用原键、已成功查询不重复写、资料门禁跨阶段恢复、身份隔离、迟到响应、确定失败可纠正、回执不随注销丢失。
- localhost API + worker 完整图片/积分/奖励主链路；最终兑现后可用及预留均为0，终态无取消动作。
- 原生 Chrome 可见验证：本地微信登录→强制上传头像/昵称→真实图片 READY→家庭创建→家长首页导航。

微信真机的登录、相机/相册系统权限、分享文件及发布审核仍需使用真实微信环境验收；本地 HTTP 测试不声称代替微信真机验证。
