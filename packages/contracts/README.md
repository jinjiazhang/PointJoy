# API 契约

[openapi.json](openapi.json) 包含 120 个实际注册接口及 37 个结构模型。

生成：`npx tsx scripts/generate-contracts.ts`。完整业务语义、枚举约束和条件必填见 [技术规格](../../docs/06-技术文档.md)。微信不直接发送PATCH，使用POST方法覆写；鉴权、版本与幂等仍使用原PATCH语义。
