# 日常与活动（0.2.0）

主导航：群组 / 日常 / 活动 / 奖励 / 我的。日常和活动为不同主页面；日常每天可参与一次，活动有明确的起止时间且每人一次。两者各有历史记录入口。

## 数据模型

| 表 | 作用 | 唯一约束 |
| --- | --- | --- |
| daily_routines | 日常名称、要求、奖励积分、启停状态、创建人 | groupId + id |
| daily_entries | 每位成员每天的参与与审核状态 | routineId + memberId + occurrenceDate |
| events | 活动名称、要求、奖励积分、必填的开始/结束时间、状态 | groupId + id |
| event_entries | 活动参与与审核状态 | eventId + memberId |

每日记录 occurrenceDate 为 DATE，按北京时间自然日取值；活动表不含日常字段，活动记录无日期占位字符串。每条参与记录保存 awardPoints、截止时间、提交/审核时间、版本、审核人及唯一积分流水关联。

服务端分别使用四个模型；返回统一展示 DTO 时附加 kind、activityId、period，仅用于展示，不是数据库共用表设计。日常/活动均验证本群外键，审核通过与积分到账在同一事务内完成，禁止审核自己及重复发分。

## 接口

以 `/api/v1/groups/{groupId}` 开头：

- POST `/routines`：发布日常，title、description、points。
- POST `/events`：发布活动，除上述字段外必须提供 startsAt、endsAt。
- POST `/routines/{id}/claim`、`/events/{id}/claim`：参与。
- POST `/routines/{id}/close`、`/events/{id}/close`：停止新参与。
- POST `/daily-entries/{id}/submit`、`/event-entries/{id}/submit`：提交说明和 expectedVersion。
- POST `/daily-entries/{id}/review`、`/event-entries/{id}/review`：管理员审核。
- GET `/me/participations?kind=DAILY|LIMITED&cursor=...`：本人对应分类历史，每页默认 30。
- GET `/activity-progress?kind=DAILY|LIMITED&date=YYYY-MM-DD`：管理员完成情况；日常按日期统计，排除当日之后创建或之前已关闭的规则。

旧 `/activities`、`/activity-claims` 接口移除，不做数据兼容。

## 全量重建

用户明确授权清空全部数据（包括微信用户账号）。2026-09-18 在停止 PointJoy 后备份数据库及头像文件，再重建线上 pointjoy 数据库并应用全部迁移，清空当前头像目录。用户、会话、群组、积分、奖励、兑换和参与记录全部清空，不导入演示数据。恢复使用须重新微信登录、创建群组。

客户端数据版本 `daily-events-v1` 首次运行时清理旧 `pj-` 登录、群组与待确认操作缓存。备份位于服务器 `/var/backups/pointjoy`，不对外提供访问。

## 0.2.1 管理入口分离

首页及管理导航分别提供「日常管理」「活动管理」。日常管理仅展示日常，可发布日常并进入日常审核；活动管理仅展示限时活动，可发布活动并进入活动审核。发布表单固定所属类型，审核页通过 kind 参数锁定分类，日常保留日期筛选，两个分类均支持按项目或按成员查看。首页管理入口共五项：成员、日常、活动、奖励、兑换。

## 0.2.2 管理入口布局

「我的」提供日常管理、活动管理、奖励管理，进入对应发布与编辑页面。首页提供成员管理、日常审核、活动审核、兑换管理；审核入口直接进入固定分类的完成情况页。管理页面移除审核按钮。
