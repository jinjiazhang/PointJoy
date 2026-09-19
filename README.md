# PointJoy 家庭积分

让孩子通过日常活动和阶段挑战获得积分，再申请兑换家庭约定的奖励。家长负责制定计划、审核完成、批准兑换和确认兑现；孩子可以用自己的微信账号登录，也可以在家长设备上进入受限的孩子模式。

新版产品规格保存在 [docs/family-redesign-v1](docs/family-redesign-v1/)。这里说明当前实现与可重复运行方式，不作为部署成功或微信审核通过的证明。

## 当前实现

- 前端使用 uni-app / Vue 3 / TypeScript，32 个页面统一为 iOS 27 启发的简洁界面。1.1.2 顶部采用紧凑单行导航：家长主标签显示可点击切换的家庭名称与页面短标题，详情及表单显示返回图标与短标题；去掉独立品牌行和正文重复标题。底部延续全宽白底、贴底固定标签栏，保留家庭内容卡片与奖励确认浮层。见 [v1.1.2 界面实现说明](docs/mini-ui-v1.1.md)。
- 微信登录后，先上传头像并保存昵称，再进入家庭业务；成人关系与孩子档案分开，支持邀请、负责人确认、解绑和成员撤权。
- 日常计划按日期、版本和适用孩子生成历史实例；挑战保留发布时约定。支持草稿、可选完成照片、审核退回、家长补记、免做及原奖励撤销。
- 积分账户分别记录可用与预留积分。兑换申请同时预留积分、库存和每周额度，家长批准后扣除预留；取消、拒绝和 72 小时到期按原价释放或退款。
- 提供心愿、成长记录、家庭待办、积分账本、审计、数据导出和删除申请。恢复保护日志独立于普通数据库备份，避免旧备份重新放行已经撤销的权限。

技术实现采用 npm workspaces：

| 目录 | 职责 |
| --- | --- |
| `apps/api` | Fastify 5、TypeScript、Zod、原生 `pg` 参数化 SQL；PostgreSQL 16 |
| `apps/api/src/identity`、`family`、`media`、`privacy` | 登录会话、家庭权限、私有图片、隐私处理 |
| `apps/api/src/domain` | 计划实例、完成审核、积分、奖励订单、统计和对账 |
| `apps/api/src/common` | 事务、幂等、审计、Outbox、安全日志与恢复 |
| `apps/api/migrations` | 按顺序执行并校验内容的 SQL 迁移 |
| `apps/mini` | uni-app、Vue 3、TypeScript、Pinia；微信小程序与 H5 构建 |
| `packages`、`scripts` | 生成契约、服务端打包和微信上传工具 |
| `tests` | 使用隔离 PostgreSQL 的流程、权限、并发、恢复与隐私维护测试 |
| `ops` | 服务配置、备份、恢复和隐私维护运行手册 |

API 与 worker 共用数据库，分别运行。账务变化使用显式事务和行锁，审核、积分、订单与幂等结果在同一事务提交。头像及完成照片由服务器验证、归一化并私有保存；图片读取仍检查当前会话权限。详细规则以产品规格、代码和测试为准。

## 本地启动

需要 Node.js 24（仓库 `.node-version` 为 `24.7.0`）、npm `11.5.1`、PostgreSQL 16。恢复测试还需要同版本的 `pg_dump` / `pg_restore`。以下命令均从仓库根目录执行：

```sh
npm ci
createdb pointjoy_rebuild_local
cp apps/api/.env.example apps/api/.env
npm run migrate:deploy
npm run dev
```

按本机 PostgreSQL 用户和密码修改 `apps/api/.env` 的 `DATABASE_URL`。API 默认监听 `127.0.0.1:4100`，健康检查为 `GET /api/v1/health`。另开一个终端启动后台任务：

```sh
npm run worker -w @pointjoy/api
```

H5 开发启动：

```sh
VITE_API_BASE_URL=http://127.0.0.1:4100/api/v1 VITE_LOCAL_AUTH=true npm run dev:h5 -w @pointjoy/mini
```

`VITE_LOCAL_AUTH=true` 用于本地 H5 的开发身份入口。API 仅在 `APP_ENV=local/test` 接受本地登录夹具；正式微信构建使用真实微信登录。小程序真机调试时配置可访问的 HTTPS API、实际 AppID/AppSecret 与微信后台域名，不能使用手机自身的 `127.0.0.1` 访问电脑 API。

运行配置示例见 [API 环境变量](apps/api/.env.example) 和 [前端环境变量](apps/mini/.env.example)。生产环境还需独立的会话/响应加密/安全日志密钥、私有媒体与导出目录和支持入口。真实密钥、`.env`、上传私钥、数据库备份及私有图片均不进入 Git。

## 测试与构建

测试会删除并重建各自专用数据库的 schema。先创建以下隔离数据库，勿替换成生产库或本地业务库：

```sh
createdb pointjoy_rebuild_test
createdb pointjoy_domain_test
createdb pointjoy_identity_qa_20260919
createdb pointjoy_recovery_test
createdb pointjoy_privacy_maintenance_qa
npm run check
```

`npm run check` 执行所有类型检查、全部测试、API 编译以及 H5 / 微信小程序构建。也可单独执行 `npm run typecheck`、`npm test` 或 `npm run build`。

截至本次重建验证，全部 **106 项测试通过**，按测试运行器计数（包括父测试）：

| 测试 | 数量 | 数据库配置 |
| --- | --- | --- |
| HTTP 完整业务流程 | 23 | `TEST_DATABASE_URL`；库名固定 `pointjoy_rebuild_test` |
| 领域并发和账务不变量 | 14 | `DOMAIN_TEST_DATABASE_URL`；库名固定 `pointjoy_domain_test` |
| 身份、权限和隐私安全 | 16 | `localhost/pointjoy_identity_qa_20260919` |
| 真实备份恢复与日志重放 | 13 | `RECOVERY_TEST_DATABASE_URL`；库名固定 `pointjoy_recovery_test` |
| 隐私维护及备份轮换确认 | 10 | `localhost/pointjoy_privacy_maintenance_qa` |
| 前端传输、图片保存与操作恢复 | 30 | 无数据库 |

未指定 URL 时，测试默认使用本机 PostgreSQL。身份和隐私维护测试使用固定本机库名，通过 `PGUSER`、`PGPASSWORD`、`PGPORT` 指定角色和连接参数；CI 已为这五个隔离库配置独立实例。恢复测试可通过 `PG_DUMP_BIN`、`PG_RESTORE_BIN` 指定 PostgreSQL 16 客户端路径。

仓库根 `overrides` 修复了 uni-app 依赖链中的安全版本；部分包仍有旧的 peer 版本声明。当前锁文件已经过干净安装、0 漏洞审计、全部类型检查、测试和两种前端构建验证。升级依赖时保留这些验证，不通过删除锁文件或忽略检查来掩盖不兼容。该审计范围为仓库工作区，不包含单独安装的微信上传工具。

构建输出：

- API：`apps/api/dist/`
- H5：`apps/mini/dist/build/h5/`
- 微信小程序：`apps/mini/dist/build/mp-weixin/`
- `npm run package:server`：生成 `work/pointjoy-server-release.tgz`，用于受控部署。

[GitHub Actions CI 模板](ops/ci.github-actions.yml) 配置为在 Node 24、PostgreSQL 16 上执行 `npm ci`、依赖审计、迁移检查和 `npm run check`。当前 Git 推送凭据缺少 `workflow` scope，因此模板尚未启用；具备仓库工作流权限后，将它放到 `.github/workflows/ci.yml`。CI 不持有生产密钥，也不自动部署或上传微信版本。配置方式参考 [GitHub setup-node](https://github.com/actions/setup-node)、[PostgreSQL service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)（核验日期：2026-09-19）。

## 微信小程序预览与上传

上传脚本使用单独安装在被 Git 忽略的 `work/wechat-ci` 中的 `miniprogram-ci@2.1.31`：

```sh
npm install --prefix work/wechat-ci --save-exact miniprogram-ci@2.1.31
VITE_LOCAL_AUTH=false npm run build:mp-weixin -w @pointjoy/mini
npm run wechat:upload -- --preview
```

上传前核对前端 `VITE_API_BASE_URL`、`apps/mini/src/manifest.json` 和 `scripts/upload-wechat.cjs` 的 AppID。脚本默认从仓库根读取 `private.wx5c24ed9df4175b79.key`，也可通过 `WECHAT_UPLOAD_KEY_PATH` 指向仓库外的绝对路径；私钥必须来自该小程序的微信后台，不能入 Git。实际上传使用：

```sh
WECHAT_UPLOAD_KEY_PATH=/ABSOLUTE/PATH/TO/private.key npm run wechat:upload
```

可用 `WECHAT_DESC` 设置版本说明。预览二维码和工具结果保存在 `work/`。上传成功代表代码送达微信开发版本，后续体验、审核与发布以微信平台状态为准。

## 运维入口

- [恢复运行手册](ops/RECOVERY.md)：恢复旧备份后重放独立日志，撤权、解绑和删除不能随备份回退。存在不确定权限、旧 PIN 或未完成清理时保持关闭访问。
- [隐私维护运行手册](ops/PRIVACY.md)：在线删除、备份轮换确认、支持工单与独立核验。
- [领域测试及对账恢复](tests/domain/README.md)：`npm run reconcile` 检查账本、订单、库存和额度；发生异常时冻结相应范围，修复后再显式复核解冻。

源码工作区的恢复命令为 `npm run recovery -w @pointjoy/api -- --operator NAME --journal-custody-confirmed`。部署包的 API 目录也提供 `npm run recovery`。安全日志及其签名清单必须独立保管，不能用普通旧备份覆盖；生产性能、恢复时效、微信审核和发布状态需分别实际验收。
