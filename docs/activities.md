# 活动（0.1.5）

原任务功能重建为活动，不保留旧任务及领取数据。数据库迁移删除旧任务表、建立 activities/activity_claims；已有用户、群组和积分账本保留。

- 日常 DAILY：每天每人一次，以北京时间自然日为周期，参与后须在当天结束前提交。
- 限时 LIMITED：管理员设置开始/结束时间，每人整个活动一次，在 [开始, 结束) 内参与并提交。
- 两类均需管理员审核后才发积分。截止前提交的记录可在截止后审核；截止后不能修改或重提。管理员不能审核自己的记录。
- 停止参与阻止新参与，已参与者仍可在原截止前提交。活动发布后奖励积分固定。

状态：CLAIMED → SUBMITTED → APPROVED，或 SUBMITTED → REJECTED → SUBMITTED。过期由 expiresAt 判断，不自动改写记录状态。

POST 接口以 `/api/v1/groups/{groupId}` 开头，要求登录和 Idempotency-Key：

| 路径 | 入参 |
| --- | --- |
| `/activities` | title、description、points、kind；LIMITED 额外要求 startsAt/endsAt（带时区 ISO 时间） |
| `/activities/{id}/claim` | 空对象 |
| `/activities/{id}/close` | 空对象 |
| `/activity-claims/{id}/submit` | submission、expectedVersion |
| `/activity-claims/{id}/review` | decision: APPROVE/REJECT、reason、expectedVersion |

发布、关闭和审核仅管理员可操作；提交仅本人；所有操作限本群。dashboard 返回 activities、activityClaims、activityDate（北京时间日期）、serverTime。普通成员只收到自己的记录。

每天资格通过 `(activityId, memberId, period)` 唯一约束隔离；日常 period 为 YYYY-MM-DD，限时为 ONCE。参与截止时间保存到记录。审核通过、账本与账户更新、参与状态及审计记录在同一事务内提交，锁定记录并校验版本，防重复发分。

当前最多读取最近 100 个活动、200 条参与记录；个人界面显示最近 20 条参与历史。暂未提供历史分页、附件或通知。

## 完成情况与审核（0.1.6）

管理员通过「活动 → 完成情况与审核」选择日常/限时，可按活动或成员展开。日常支持北京时间日期筛选，未参与成员也列出，截止未提交和驳回未通过分别显示。审核后重新读取统计。

GET `/api/v1/groups/{groupId}/activity-progress?kind=DAILY&date=YYYY-MM-DD`：仅本群管理员，返回 activities、members、claims、day、kind、serverTime；按分类和日期独立查询，不受 dashboard 的最近 200 条限制。日常排除所选日期之后创建的活动和加入的成员。限时仅统计活动结束前已入群或有参与记录的人。该接口当前返回所选范围完整数据，尚未做大群分页。

### 独立页面（0.1.7）
活动页不再显示参与/审核页签。管理员从「发布活动」旁的「完成情况」按钮进入 `/pages/activity-progress/index?groupId=...` 独立页面；使用原生导航返回。页面保留日常/限时、日期和按活动/成员筛选。审核不确定时保留原幂等请求，重新进入可恢复确认。

0.1.8：独立页面入口从发布活动旁移至首页「管理成员」右侧，按钮名「活动审核」。

0.1.9：首页四入口统一为成员管理、活动管理、奖励管理、兑换管理。发积分位于成员管理；发布与审核位于活动管理；活动参与页和奖励兑换页移除管理按钮。

0.1.10：活动参与页合并日常/限时列表，限时排前并显示橙色标签；管理页面仍保留类型筛选。参与记录通过文字链接进入独立页面，GET /groups/{groupId}/me/activity-claims 返回本人的分页记录和对应活动信息，每页 30 条；包含权限及分页测试。

## 0.2.0 替代说明

本文件前面的合并表和旧接口描述为历史版本。当前表结构和接口以 [日常与活动重建说明](daily-event-redesign.md) 为准，已授权全量清空线上数据，不提供旧版兼容。
