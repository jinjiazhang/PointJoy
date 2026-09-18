# PointJoy 体验版部署

服务器：`ssh ubuntu@pointjoy.jinjiazh.com`，Ubuntu 24.04。

- 网站：`https://pointjoy.jinjiazh.com/`（介绍页）。
- API：`https://pointjoy.jinjiazh.com/api/v1`。
- API 文件：`/opt/pointjoy/api`，运行时：`/opt/pointjoy/runtime`（Node 24）。
- 服务：`pointjoy.service`，专用系统用户 `pointjoy`，监听 `127.0.0.1:4100`。
- 环境变量：`/etc/pointjoy/api.env`，root 可读，包含数据库密码、微信密钥及幂等结果加密密钥。
- 数据库：PostgreSQL 16，数据库/角色 `pointjoy`，仅监听本机；没有导入演示用户。
- Nginx：`/etc/nginx/conf.d/pointjoy.conf`，只配置此域名。
- 证书：`/etc/nginx/ssl/pointjoy.jinjiazh.com_bundle.crt`；当前证书到期日 2026-12-15，需提前续期。
- 每天服务器时间 03:30 备份到 `/var/backups/pointjoy`，约保留 7 天。本机备份不能替代异地备份。

查看状态：`sudo systemctl status pointjoy`；查看日志：`sudo journalctl -u pointjoy`。

更新代码需重新编译，上传产物，生成 Linux Prisma Client，应用数据库迁移，再重启 `pointjoy`。运行目录不包含 AppSecret 原文件或上传私钥。当前远端 npm 安装生成了独立 package-lock，后续部署应保留该锁文件或使用一致的构建流程。

## 微信上传

1. 微信后台 request 合法域名配置为 `https://pointjoy.jinjiazh.com`。
2. 上传 IP 白名单添加实际执行上传的公网 IP；2026-09-17 本机上传请求被识别为 `119.147.10.192`。
3. `npm run build:mp-weixin -w apps/mini`。
4. 首次执行 `npm install --prefix work/wechat-ci miniprogram-ci`，然后 `node scripts/upload-wechat.cjs`。
5. 微信后台版本管理中将上传的开发版本设为体验版，并添加体验成员。

2026-09-17：HTTPS/API 健康检查和微信 AppID/AppSecret 验证成功；15 项自动化测试通过。首次上传被微信 IP 白名单拒绝（-10008），待配置后重试。真实微信 code 登录仍需手机验收，不能以模拟测试替代。

2026-09-18：用户已关闭上传 IP 白名单并配置服务器域名，版本 0.1.0 成功上传至微信（包体 1,336,175 字节）。后台健康检查通过。待在微信公众平台将该开发版本设为体验版并进行真机验收。

2026-09-18 / 0.1.3：新增 PATCH /me 修改昵称、POST /me/avatar 接收 base64 头像并验证/重编码为 256px JPEG。头像目录 /var/lib/pointjoy/avatars（pointjoy 可写），通过 /api/v1/avatars 静态读取；此目录需单独备份。用户通过微信 chooseAvatar 和 nickname 输入框主动填写资料。16 项自动化测试通过，线上健康检查通过。

2026-09-18 / 0.1.4：新增群任务发布、领取、提交完成、审核发积分和驳回重提；迁移 202609180001_tasks 已应用，17 项测试通过。接口及数据规则见 docs/tasks.md。

2026-09-18 / 0.1.5：任务替换为日常/限时活动。迁移 202609180002_activities 已在备份后执行，旧任务及领取表已删除重建。18 项测试通过，规则与新接口见 docs/activities.md。

2026-09-18 / 0.1.6：审核移入独立完成情况视图，按日常/限时、活动/成员及日常日期查看。19 项测试通过，无数据迁移。

2026-09-18 / 0.2.0：用户明确确认清空全部数据（包含微信账号）。已暂停服务、备份数据库和头像，再重建 pointjoy 数据库并应用五个迁移，当前头像目录已清空，服务恢复。用户/群组/账本/日常/活动数量均验证为 0。新数据结构见 docs/daily-event-redesign.md；19 项测试及构建通过。
