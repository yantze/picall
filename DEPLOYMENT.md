# Workers 发布记录

## 当前部署：DeepSeek BYOK

发布时间：2026-11-08 02:07:49（Asia/Shanghai）。

- 服务地址：https://picall-agent-search.vastiny.workers.dev
- 源码提交：`3efcc25fb94e681e7ae8492ee1f12057e69e2b67`（Cloudflare 分支）
- Worker version：`9f480bb9-4c98-4b19-9aba-ff2a4200ecc5`
- Deployment：`be55926c-c720-4034-95f6-cfced0f5f162`，流量 100%。
- 配置：`MODEL=deepseek-flash`、`AI_GATEWAY_ID=deepseek`。
- 原生调用 DeepSeek，使用网关中已存在的 `default` BYOK 密钥；不把密钥复制到源码或 Worker，并禁止统一计费回退。
- 原有 API_BEARER、搜索 Secrets、普通变量和两个 DO namespace 均从线上最新版本继承，namespace ID 未改变。
- 已开启 Workers Logs 和 1% 采样的 Traces。
- bundle SHA-256：`b22a3778ca639bed54d2b78628265aabc31fed2496d754e7300b59030e58e908`。

23 项本地自动测试、绑定类型同步检查、TypeScript 和生产 dry-run 均通过；其中包括 DeepSeek 原生路径、凭证不外传、禁止统一计费、模型引用恢复及完整工具循环 JSON/SSE。Cloudflare API 已核对以上部署和绑定信息。开发执行环境仍无法访问 workers.dev，因此真实 DeepSeek 应用请求还需调用方验收；mock 结果不代表上游密钥或余额已验证。

调用方应省略 model 使用部署默认值，或显式发送 `"model":"deepseek-flash"`。不要继续传旧的 GLM 模型 ID；模型切换后请使用新会话。旧失败 run 不会因配置更新自动重跑。

## 首次发布历史：Workers AI

以下为此前版本的历史记录；当前生效配置以上文为准。

发布时间：2026-11-08 01:35:51（Asia/Shanghai）。

- 服务地址：https://picall-agent-search.vastiny.workers.dev
- Worker：`picall-agent-search`
- 源码分支：`Cloudflare`
- 已部署源码提交：`899667768d9722137ea04ac616824589099905eb`
- Worker version：`3d12f7bf-677c-441e-8cfa-4c21c5340024`
- Deployment：`8bddb21e-546d-414d-97d5-2d5162ca1685`
- 流量：该版本 100%；workers.dev 已启用，版本预览地址关闭。
- 上传 bundle SHA-256：`920dd4d431030d3616d00ea621116fe181788b2f925f52e4a80f302c97500807`

使用仓库锁定的 Wrangler 4.158.0 执行 `deploy --dry-run --minify` 构建，再通过已连接的 Cloudflare 插件上传同一 bundle。大小约 1.06 MiB / gzip 301 KiB；Cloudflare 返回启动时间 17 ms。本次是 API 直接发布，没有建立 GitHub 自动部署；仓库 CI 仍只运行检查、测试和 dry-run。

## 已由 Cloudflare API 核对

- `AI` Workers AI binding；默认模型 `@cf/zai-org/glm-5.3-flash`。
- `SESSIONS` → `SearchSession`，`KEYS` → `RequestKey`；SQLite 类迁移标记 `v1`。
- 独立随机 `API_BEARER` 已作为 secret_text 配置，明文未进入源码、Git、命令参数或日志。
- 日期 `2026-11-07`、`nodejs_compat`、搜索代理地址及空的 HTTP_TOOLS/READ_HOSTS 与仓库配置一致。
- 最新 deployment 的 version 比例为 100%，公开 workers.dev 域名已启用。

## 尚未完成

当前开发环境的出站策略拒绝 `picall-agent-search.vastiny.workers.dev`。已尝试不带凭证的 `/v1/models` 检查，但请求在到达 Worker 前被代理拒绝（CONNECT 403）；这不是 Worker 返回的 HTTP 验收结果。Cloudflare 插件中的直接 HTTP 探测也被域名策略阻挡。

因此，尚未验证线上 401/200、JSON/SSE、真实模型调用和真实搜索研究质量。本地的 20 项自动测试结果仍有效，但不能替代线上验收。

第三方搜索密钥 `BRAVE_KEY`、`TAVILY_KEY`、`TINYFISH_KEY` 尚未配置；可选的 `EXA_KEY`、`JINA_KEY` 也未配置。`READ_HOSTS` 当前为空，正文读取会按设计拒绝；在完成 README 所述安全边界检查后配置可信来源域名。

首次调用需使用已生成的 API_BEARER，或在 Cloudflare 控制台重设该 secret 为自己管理的值。生成值的受限交付文件仅位于云端工作区被 Git 忽略的 `.wrangler/publish/API_BEARER.txt`，不随仓库或部署记录公开。不要将真实密钥粘贴到 issue、提交或聊天。
