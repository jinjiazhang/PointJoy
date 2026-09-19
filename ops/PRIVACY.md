# 隐私申请、备份轮换与账号支持值班手册

适用服务：PointJoy v1；生产由独立 `pointjoy_privacy` 数据库角色处理，命令由受授权的服务器运维人员执行。不要把数据库连接串、备份密钥、PIN、恢复码或用户照片贴进终端记录、工单或聊天。

## 1. 对用户实际承诺的阶段

- 导出通常 24 小时内生成，最多 3 个自然日；私有下载文件保留 7 天。
- 有效删除申请在 7 个自然日内完成在线数据删除或不可逆去标识化。`privacy_requests.status=COMPLETED` 与 `outcome_code=ONLINE_DELETION_COMPLETED` 表示这一阶段。
- 在线删除后的备份最多保留 35 天。`deletion_tombstones.completed_at IS NULL` 时，独立回执仍显示 `backupStatus=PENDING`。
- 只有真实备份轮换核验通过，工具才记录备份完成时刻，并设置 `clear_after=确认完成时刻+30天`。不会因定时器到期而直接宣称全部删除。
- 用户在提交删除申请时保存 `receiptToken`。即使账号已经停用，`GET /api/v1/privacy-receipts/{token}` 仍可读取最少进度；该凭证不允许查询账号、家庭、照片或导出内容。

`receiptToken` 是只读凭证，也应保密。值班人员通过申请 ID 工作，不索取该 token。

## 2. 部署前配置与实际备份范围

代码入口：`apps/api/src/privacy/maintenance.ts`；生产入口：`/opt/pointjoy/api/dist/privacy/maintenance.js`。开发入口使用 `tsx src/privacy/maintenance.ts`，生产不依赖开发依赖。

将以下配置写入 `/etc/pointjoy/privacy-maintenance.json`，所有者 `root:root`，权限 `0600`：

```json
{
  "version": 1,
  "backupDirectories": [
    {
      "path": "/var/backups/pointjoy-v1",
      "kind": "ROTATING",
      "keyFile": "/etc/pointjoy/backup.key"
    },
    {
      "path": "/var/backups/pointjoy-rebuild",
      "kind": "LEGACY",
      "keyFile": "/etc/pointjoy/backup.key"
    }
  ],
  "exportDirectory": "/var/lib/pointjoy/exports",
  "backupLockFile": "/run/lock/pointjoy-backup.lock",
  "maxLatestBackupAgeMinutes": 30
}
```

生产工具校验这些完整范围，不能临时指向空目录来取得“完成”。若后来增加异机、对象存储或离线复制，必须先扩展备份清单与核验实现；当前命令不能证明未登记副本已经删除，有此类副本时不得执行最终确认。两个备份目录必须始终存在，所有者为 root，组和其他用户不得写入；旧版目录的快照删除后，保留空目录即可。当前常规备份必须至少有一个最近 30 分钟内的有效文件。

常规备份每 10 分钟产生 `YYYYMMDDTHHMMSSZ.tgz.enc`，保留 35 天。重建前快照 `before-v1.dump.enc` 也须在其 35 天保留期结束后实际移除。`/var/backups/pointjoy` 中的旧原始副本和 `/var/backups/pointjoy-stage.*` 中的暂存原始数据库/媒体不属于可忽略的文件：生产确认发现这些目录仍存在，会保持待处理。

值班人应核对 `pointjoy-backup.timer`、`pointjoy-backup.service` 和 `ops/backup.sh` 的实际状态。确认工具不会主动删除备份，也不会替代可恢复性演练。现有 `backup.sh` 中的清理命令必须覆盖常规备份和重建前快照；暂存目录须在备份完成或失败退出时清理。若主机被强制停止而遗留暂存目录，先确认没有备份作业持有锁，再清理经核实的 PointJoy 暂存副本。

数据库角色所需最少授权由部署脚本配置：

- `privacy_requests`：SELECT、UPDATE。
- `deletion_tombstones`：SELECT、UPDATE。
- `audit_logs`：SELECT、INSERT。
- 数据库 CONNECT 与 schema USAGE。

该工具不需要用户认证身份、PIN 凭据、积分流水的写权限。备份密钥仅由 root 读取以验证加密备份，永不写入审计或命令输出。

## 3. 每日备份删除核验

每天至少检查一次到期申请，发现异常立即处理；不要等用户追问。先加载配置数据库角色的环境文件，设置实际可追责的操作人 ID。共享值班账号不足以区分人员时，工单中也要记录实际接手人。

```bash
sudo -i
set -a
. /etc/pointjoy/worker.env
set +a
export PRIVACY_DATABASE_URL="$DATABASE_URL"
export POINTJOY_OPERATOR_ID='填写实际运维账号标识'
cd /opt/pointjoy/api
exec 9>/run/lock/pointjoy-backup.lock
flock -x 9
export POINTJOY_BACKUP_LOCK_FD=9
node dist/privacy/maintenance.js backup-check \
  --config /etc/pointjoy/privacy-maintenance.json \
  --operator "$POINTJOY_OPERATOR_ID"
```

操作人 ID 允许字母、数字、`@._+-`，不允许占位中文直接执行。数据库连接串不会被工具输出；生产要求连接用户为 `pointjoy_privacy`。

`backup-check` 只核对、生成报告，不写完成记录。要处理单一申请，可增加 `--request-id <申请UUID>`。确认报告内容后，在同一备份锁内执行：

```bash
node dist/privacy/maintenance.js backup-confirm \
  --config /etc/pointjoy/privacy-maintenance.json \
  --operator "$POINTJOY_OPERATOR_ID"
flock -u 9
exec 9>&-
```

生产命令会验证 Linux 的 `/proc/self/fdinfo/9` 中确有对应文件的排他 `flock`，不会只相信环境变量。若从 `backup.sh` 内调用，复用已持有的 FD 9，并先清理本轮 `pointjoy-stage.*` 暂存目录；不要递归再取同一把锁。

程序核验：

1. 在线删除记录真实完成，且在线完成时刻与删除标记中的较晚时间已满 35 天；数据库 `backup_purge_due_at` 也已到达。
2. 两个必需备份目录和导出目录均可读取，路径无符号链接，生产权限可信；没有未知文件、未完成的 `.partial`、临时原始副本或未登记目录。
3. 逐个备份按文件名时间、mtime、可用创建时间中的较早者判断，任何不晚于在线删除的副本仍存在都阻断确认。
4. 最新常规备份足够新，执行完整 AES-256-GCM 认证并记录加密文件 SHA-256；不将解密内容写到磁盘或输出。此步骤证明最新备份完整可解密，不代替数据库恢复演练。
5. 导出目录不存在孤儿文件、到期文件、早于删除时刻的副本、已删除主体的导出，且数据库与导出文件对应一致。
6. 完成前再次扫描文件清单，确认核验过程中没有变化；随后在数据库锁内写完成时刻、30 天保留截止和带实际操作人及核验摘要的审计。

结果含义：

| state | 含义与动作 |
|---|---|
| `NOT_DUE` | 尚未满 35 天；保留待处理，不调整日期。 |
| `PENDING` | 有具体阻塞原因；定位并解决，再重新核验。 |
| `ELIGIBLE` | 只读检查通过；尚未写备份完成记录。 |
| `COMPLETED` | 本次实际核验并写入完成；用户独立回执已可看到备份完成。 |
| `ALREADY_COMPLETED` | 已存在完成证明；不会重复延长 30 天保留期或重复结单。 |

退出码 `0` 表示命令成功执行且没有到期阻塞；`2` 表示存储核验有异常或到期申请仍待处理；`1` 表示配置、锁、数据库或命令参数错误。报告中的路径和摘要仅保存在受限运维记录中。没有任何 `--now`、强制通过或跳过目录检查选项。

常见处理：旧备份按已授权的保留策略轮换；缺目录则核对挂载和备份服务，不创建一个无来源空目录掩盖挂载失败；最新备份认证失败则检查密钥配置并执行恢复演练；遗留导出通过隐私任务修复文件与数据库状态，不直接把 tombstone 标为已完成。

核验完成后的最少回执和标记保留到 `clear_after`。删除这些标记、独立恢复日志和对应受限审计，必须由协调后的保留清理流程执行，不能单独手删清单中的日志文件破坏恢复保护签名。

## 4. PIN 支持工单受理

用户入口：`POST /api/v1/support/pin-recovery-requests`，提供问题说明及可选联系渠道；原锁定账号可通过 GET 同一路径查看进度。工具支持真实接单、负责人员与状态说明，但不提供管理员 PIN 重置按钮，也不会因等待满三天自动解锁。

每天检查新工单，在一个工作日内受理；最迟三个自然日给出可处理结论或具体补充要求。值班人使用同样的数据库环境，无须备份锁：

```bash
node dist/privacy/maintenance.js support-list --status RECEIVED --limit 30
node dist/privacy/maintenance.js support-show --request-id <申请UUID>
```

列表只展示处理所需的申请摘要；详情仅展示用户已提交的问题说明和可选联系渠道，并遮掉明显的六位 PIN / 格式化恢复码。不查询孩子照片、学校地址或证件。不要在工单中复制原 PIN、恢复码和微信凭据。

将要向用户展示的说明写到权限 `0600` 的短期文件，避免多行说明或敏感内容进入 shell 历史：

```bash
umask 077
cat > /run/pointjoy-support-note.txt <<'NOTE'
已受理。当前材料尚不足以确认成年人身份，请按支持渠道提供既有工单中要求的独立证明。
NOTE
node dist/privacy/maintenance.js support-update \
  --request-id <申请UUID> \
  --expected-version <列表中的version> \
  --status VERIFYING \
  --operator "$POINTJOY_OPERATOR_ID" \
  --note-file /run/pointjoy-support-note.txt \
  --evidence-reference <受限工单编号>
rm /run/pointjoy-support-note.txt
```

`evidence-reference` 只放受限证明材料的索引，不放原件、下载凭证或个人内容。每次更新核验 `expectedVersion`；出现冲突须重读，不能覆盖另一位值班人的说明。工具记录 `assigned_at`、最新操作人审计，并保留原 `due_at`，不会偷偷延长用户期限。

允许的流程：

- `RECEIVED → VERIFYING / NEEDS_ACTION / REJECTED`。
- `VERIFYING → VERIFYING / NEEDS_ACTION / REJECTED`。
- `NEEDS_ACTION → VERIFYING / NEEDS_ACTION / REJECTED`。
- `REJECTED` 是本次支持结论，不自动重开或重置。

缺少充分独立证明时，使用 `NEEDS_ACTION` 明确需要什么；无法取得足够证据时，以 `REJECTED` 告知无法重置，保持账号锁定。知道孩子昵称、同一设备、静默微信登录或仅持账号登录身份，都不是足够的成年人证明。

本工具不能把隐私导出/删除申请改为完成，也不更改 `pin_credentials`、用户安全版本或会话。任何未来人工恢复流程必须另行实现两名独立操作人复核、预先批准的证据方案、撤销全部会话与独立恢复保护日志；本版本不允许手工改 SQL 哈希作为替代。

## 5. 本地核验

测试只允许重置独立数据库 `pointjoy_privacy_maintenance_qa`。使用临时目录中的加密文件与测试时间戳，不读取生产备份：

```bash
createdb pointjoy_privacy_maintenance_qa
./node_modules/.bin/tsx --test tests/privacy-maintenance/maintenance.test.ts
```

测试覆盖旧常规和旧版备份、缺目录、错误认证标签、partial、符号链接、孤儿/过期导出、只读 CLI、实际轮换后回执完成、35 天最低期限、重复确认不重写，以及支持受理始终不改 PIN。
