# 家庭版部署与本次发布记录

记录日期：2026-09-19（Asia/Shanghai）。目标域名 https://pointjoy.jinjiazh.com，SSH 使用 `ubuntu`。本次是用户明确授权的重建，不迁移旧账号和业务数据。

## 本次实际结果

- 旧实现与旧说明已先从仓库删除并推送，清理提交为 `03dea17`；当前产品与设计文档统一维护在 [docs](../docs/README.md)。
- 服务器停止旧服务后，清理 `/opt/pointjoy/api`、`/opt/pointjoy/site`、旧头像目录和旧原始备份；移除旧备份脚本。仅重建 PostgreSQL 数据库 `pointjoy` 的 `public` schema。Node runtime、TLS 证书和其他数据库不在清理范围内。
- 新版包含 5 个迁移、48 张表。上线后核查 `users`、`families`、`child_profiles` 均为 0。没有导入旧家庭，也没有在生产库创建测试家庭。
- API 和 worker 已运行，`GET /api/v1/health` 经 HTTPS 返回 200、版本 `1.0.0`。未登录会话和资料接口返回 401；生产环境拒绝本地模拟微信登录码。站点首页与隐私说明返回 200。
- 首次启动发现 npm 在受限 umask 下生成的依赖目录无法被服务账号读取，已修正代码目录读权限并同步到部署脚本；私钥与环境文件仍为 root 所有、0600。修复后 API、worker 正常运行。
- 每 10 分钟执行加密备份，保留 35 天。首轮 `pointjoy-backup.service` 返回成功，维护 CLI 实际验证 Linux FD9 的独占锁、完整备份范围与加密认证，`storageErrors=[]`。本轮备份已实际解密、核对内部 SHA-256，并成功读取 PostgreSQL 恢复目录。
- 旧库只保留一份受限加密恢复快照 `before-v1.dump.enc`，同样按 35 天策略轮换；在线旧数据已清空。密钥独立保存在 `/etc/pointjoy/backup.key`。
- 微信 `miniprogram-ci@2.1.31` 已成功上传 AppID `wx5c24ed9df4175b79` 的 **1.0.0 开发版本**，官方返回完整包大小 **368726 字节**。小程序注册 32 个页面。首次官方编译发现 WXSS 通配符兼容问题，已从源样式修正，并添加构建后 WXSS 检查后重新上传成功。

上传成功不代表微信审核或正式发布。当前工具访问微信公众平台网页受到浏览器安全策略阻止，未进行网页提审或正式发布。管理员仍需在微信平台核对合法域名与隐私声明，进行真机体验、提交审核和发布。没有冒充通过真机微信登录、系统相册权限或微信审核。

## 验证证据与范围

### 1.1.2 精简顶部导航

2026-09-19 去除顶部“积乐圈”品牌行和正文重复家庭名、大标题，家长主页面使用一行“家庭名称 ▾ + 页面短标题”，点击家庭名进入家庭选择。详情和表单页使用返回图标与短标题；孩子主页面保留家长 PIN 入口或本人账号入口，未通过获取家长资料补充孩子导航。底部继续贴底固定。

类型检查、H5 / 微信构建和 WXSS 扫描通过。浏览器验证家庭名切换、设置页返回及单页栈返回首页；320px 窄屏中，长家庭名实际截断为省略号且页面宽度保持320px。微信胶囊预留逻辑保留，真机效果待用户体验确认。微信官方已成功上传 **1.1.2 开发版本**，完整包 **753216 字节**；预览二维码为 `work/wechat-preview-1.1.2.jpg`。上传证据为 `.var/compact-header-upload.log` 与 `.var/compact-header-preview.log`。本次未修改服务端或生产数据，开发版上传不代表正式发布。

### 1.1.1 底部页签贴底固定

2026-09-19 按用户要求，将家长四个页签和孩子三个页签统一改为全宽白底、贴底固定导航，去除悬浮留白、圆角、阴影与选中胶囊背景。底栏白底延续到底部安全区，页面内容预留相同占用高度。类型检查、H5 / 微信构建与 WXSS 扫描通过；390×844 浏览器中验证两种身份底栏均为 left=0、right=390、bottom=844，无横向溢出。

微信官方已成功上传 **1.1.1 开发版本**并生成新预览二维码，完整包 **753580 字节**。证据为 `.var/fixed-tabs-upload.log`、`.var/fixed-tabs-preview.log`；预览文件为 `work/wechat-preview-1.1.1.jpg`。本次仅调整前端导航样式，未修改业务接口或生产数据；上传不代表正式发布。

### 1.1.0 全新小程序界面

2026-09-19 已通过微信官方编译并上传 **1.1.0 开发版本**，完整包 **753983 字节**，32 个页面。基于 uni-app / Vue 3 / TypeScript 更新登录、家庭、活动、奖励、积分与孩子模式，新增玻璃导航、悬浮标签栏、统一图标及底部兑换确认浮层。微信头像、昵称和照片自动保存流程继续保留。详见 [界面实现说明](../docs/小程序界面.md)。

前端类型检查、30 项测试、H5 / 微信构建、WXSS 检查通过。本地 API + worker 完整 HTTP 联调覆盖头像、孩子头像、完成照片、草稿、审核与积分兑换。390px 浏览器实操完成家庭首页、计划、奖励申请→批准→兑现、账本、家庭管理、孩子模式与完成表单检查；兑现未勾确认时，错误可在浮层内看到。320px 心愿页无横向溢出。测试使用本地隔离家庭，没有往生产库导入展示数据。

修正积分账本首次进入时的查询分支；操作后没有页面栈时，返回当前身份首页；移除短列表冗余的到底提示。官方上传与预览均成功，二维码保存在 Git 忽略的 `work/wechat-preview.jpg`，证据日志为 `.var/ui-refresh-upload.log`、`.var/ui-refresh-preview.log` 和 `.var/ui-refresh-integration.log`。预览二维码使用范围和有效期遵循微信平台规则；本次为开发版上传，不代表提审或正式发布。微信设备的真实头像选择、登录与权限行为仍待用户体验确认。服务端协议、运行代码及生产数据库不变，HTTPS 健康检查正常。

### 1.0.2 图片自动保存修复

2026-09-19 用户反馈选择微信头像后提示图片上传中断。生产记录确认两次本人头像意图已建立，但 `uploaded_at` 均为空；未收到图片内容。旧客户端将所有文件上传失败统一显示为中断，现有证据不能据此断定是域名、网络或临时文件问题。

微信端现使用已选临时文件的 ArrayBuffer，通过 API 请求发送真实 multipart 到原受限上传地址；保留原有短时上传凭证、大小与身份校验、处理和 READY 门禁。选择微信头像即自动保存，无需用户再操作一次上传。相册/拍照改为可展开的其他头像方式，并区分超时、网络中断和凭证过期提示。

类型检查、前端 30 项测试（新增 21 项图片传输测试）、H5/微信构建通过。使用相同 multipart 编码器的本地 API + worker 完整流程验证通过，包括三类图片处理及积分兑换。微信官方已成功上传 **1.0.2 开发版本**，完整包 **378377 字节**；用户微信设备仍需体验新版确认。服务端协议、运行代码及生产数据未变更。上传证据：`.var/avatar-save-upload.log`。

### 1.0.1 微信头像昵称补充发布

2026-09-19 已成功上传微信 **1.0.1 开发版本**，官方编译后完整包为 **373620 字节**。首次资料和本人账号页面新增微信头像选择、微信昵称推荐、原生表单取值、昵称检查反馈与微信隐私同意流程；本次只更新小程序，服务端和数据库无需修改。

类型检查、9 项现有前端测试、H5/微信构建及官方上传均通过，编译产物确认保留 chooseAvatar、nickname、form submit、nicknamereview 和 agreePrivacyAuthorization。真实微信输入法与平台隐私声明仍需管理员真机核验。新上传证据保存在 `.var/wechat-profile-upload.log`，最新结果与预览仍在 Git 忽略的 `work/`。

本地干净依赖安装与审计 0 漏洞；类型检查、85 项自动化测试、API / H5 / 微信构建通过。85 为测试运行器计数，分组为 23 流程、14 领域、16 身份隐私、13 恢复、10 隐私维护、9 前端。恢复测试实际使用 pg_dump/pg_restore 和独立加密日志；本次生产备份验证了真实加密文件、校验和及恢复目录，未将备份覆盖回在线业务库。

本地受限证据：`.var/release-check.log`、`.var/production-deploy.log`、`.var/wechat-upload.log`，以及 `work/wechat-upload-result.json`。这些文件与真实配置均不进入 Git。当前 Git 凭据缺少 GitHub `workflow` scope，CI 配置保留在 `ops/ci.github-actions.yml`，尚未启用远程 Actions。不能把本地检查结果等同于远程 CI 已通过。

目前未配置异机持续备份或完整监控告警渠道；同机加密备份和独立目录的恢复日志不等同于异地灾备。隐私与支持工单需按 [PRIVACY.md](PRIVACY.md) 实际值班处理，不能仅依赖文档中的时限承诺。性能与恢复时效目标需专项验收。

## 配置与日常部署

生产布局：

| 路径 | 内容 |
| --- | --- |
| `/opt/pointjoy/api` | 编译后的 API、worker、迁移及运行依赖 |
| `/opt/pointjoy/site` | 产品入口和隐私说明 |
| `/opt/pointjoy/ops` | 备份、配置模板和运维脚本 |
| `/etc/pointjoy/{api,worker,migrate}.env` | 各进程独立数据库角色和运行配置 |
| `/etc/pointjoy/privacy-maintenance.json` | 完整备份及导出核验范围 |
| `/var/lib/pointjoy/{media,exports}` | 私有媒体和限时导出 |
| `/var/lib/pointjoy-recovery` | 独立加密保护日志与签名清单 |
| `/var/backups/pointjoy-v1` | 常规加密备份 |
| `/var/backups/pointjoy-rebuild` | 重建前加密快照，到期轮换 |

`scripts/prepare-server-secrets.mjs` 仅用于首次准备，输出到 Git 忽略的 `work/production-secrets`，发现已有配置即拒绝覆盖。已部署密钥必须保留，不得通过重新生成配置修复普通部署问题。

`ops/deploy-reset.sh` 是**本次专用、会清空数据的一次性脚本**，禁止用于后续普通更新。后续更新应运行检查、生成服务端包、准备新代码及运行依赖、备份并验证迁移，再切换 API 和 worker；不删除私有数据、密钥和恢复日志，不再次执行 DROP SCHEMA。增量迁移需要更新 `ops/grants.sql` 并核对角色权限。恢复按 [RECOVERY.md](RECOVERY.md) 处理，不能只恢复数据库后直接对外开放。

常规状态命令（使用 `ubuntu` 登录后）：

```sh
sudo systemctl status pointjoy.service pointjoy-worker.service --no-pager
sudo systemctl list-timers pointjoy-backup.timer --no-pager
curl -fsS https://pointjoy.jinjiazh.com/api/v1/health
sudo systemctl start pointjoy-backup.service
sudo journalctl -u pointjoy-backup.service -n 40 --no-pager
```

微信代码重新上传见根 README。不要把 `pointjoy.yaml`、上传私钥、环境文件、数据库备份、孩子照片或可访问私有内容的凭证放入 Git 或共享文档。
