# 从 main 部署 Cloudflare 版

本轮仅交付代码和验证，未部署、修改线上 Secrets 或切换 Git 集成。历史发布记录见 `apps/cloudflare/LEGACY_DEPLOYMENT.md`，旧版真实请求不能作为本轮验收。

## 初始化配置

使用 `apps/cloudflare/wrangler.jsonc`，保持原 Worker `picall-agent-search`、账户、域名和 DO 命名空间。兼容日期仍为 2026-11-07。

| 配置 | 用途 |
| --- | --- |
| ADMIN_TOKEN Secret | 独立管理令牌，至少 32 字符的随机值 |
| CONFIG_ENCRYPTION_KEY Secret | AES-256 主密钥，32 字节随机值的 Base64 编码 |
| API_BEARER Secret | 首次初始化研究 API 的 Bearer，已有值保留 |
| BRAVE_KEY 等现有 Secrets | 首次初始化搜索和读取配置，已有值保留 |
| MODEL、AI_GATEWAY_ID 等 vars | 初始模型和地址，默认 deepseek-flash / deepseek |
| AI binding 与 Gateway BYOK | 保留现有 DeepSeek provider 和 default alias |

管理员令牌可用 `openssl rand -hex 32` 生成，主密钥用 `openssl rand -base64 32` 生成。生成值保存在自己的密钥管理器，交互输入，不写进命令参数或仓库：

```bash
cd apps/cloudflare
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

以上是后续部署步骤，本次未执行。主密钥需备份，本轮不自动轮换或重新加密；缺失或解密失败会明确报错，不重置配置。

首次初始化后，以网页保存的加密配置为准；修改旧 API_BEARER、搜索 Secrets 或 vars 不覆盖网页配置。ADMIN_TOKEN 和 CONFIG_ENCRYPTION_KEY 始终来自 Worker Secrets，管理令牌轮换使旧登录失效。Gateway BYOK 继续在 Cloudflare 管理。

## 升级与发布

1. 让调用方暂停新研究请求，等待原任务最长预算 5 分钟；旧 GET 查询可继续。遗留旧未完成任务标记 process_interrupted，不自动重放。
2. 保留原 v1 迁移，只追加 v2 创建 Management。不要重命名 SearchSession/RequestKey、SESSIONS/KEYS、Worker 或 DO 命名算法。
3. 运行验证，再由操作者手动发布：

```bash
npm ci
npm run check
npm test
npm run build:cloudflare
cd apps/cloudflare
npx wrangler deploy
```

也可手动运行 Deploy Cloudflare manually 工作流。它只允许 main，使用 `cloudflare-production` environment 的 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID；需预先配置上述运行时 Secrets，并按需设置 environment 审批。

main 的两条验证流水线均不部署。若另外启用了 Cloudflare Git Builds，首次正式切换前仍保留原生产分支设置。本轮不发布 npm 包。

## 真实验收

- 登录、退出、配置保存、脱敏、清空密钥及 revision 冲突；Bearer 与管理 Cookie 分离。
- 真实模型 ping，以及搜索→阅读→带来源答案，记录耗时、usage 和服务调用数。
- JSON/SSE 只含最终答案，断线查询、显式取消及 DO 重建后新任务恢复。
- 已知旧 run ID、旧幂等 key 和会话历史继续可用；旧未完成任务明确失败。

客户端适配：accepted→pending、succeeded→completed、session_id→sessionId、created_at→createdAt；模型目录改为 picall/<id>，错误采用 main 的结构与状态码。旧 completion 的 ID、正文、模型记录和用量不改写。

新增应用记录和 DO 类不等于所有旧代码都能读取新数据。保留旧分支作为对照；上线后遇到格式问题优先前向修复，避免未经验证的直接回滚。两端数据仍独立。
