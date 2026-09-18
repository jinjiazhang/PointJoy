ALTER TABLE "users" ADD COLUMN "wechatOpenId" VARCHAR(128);
CREATE UNIQUE INDEX "users_wechatOpenId_key" ON "users"("wechatOpenId");
