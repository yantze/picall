# picall Cloudflare Agent Search

基于 Cloudflare Workers 的实验性 Agent Search 服务，提供 OpenAI 兼容聊天接口、持久任务查询、搜索和网页读取。执行层为 agents 0.33.0 + Pi Durable 1.5.0，模型通过 AI binding 接入 Workers AI 或 AI Gateway BYOK；不启动 Pi 子进程，不加载用户本地扩展、文件、环境或凭证。

本分支是独立仓库布局：源码、测试、package.json 和 Wrangler 配置均位于根目录，可直接安装和部署。

## 当前部署

已发布到 [picall-agent-search.vastiny.workers.dev](https://picall-agent-search.vastiny.workers.dev)。AI binding、两个 SQLite Durable Object 和 API_BEARER 已配置。搜索服务密钥已由部署方配置，但有效性与真实搜索尚未验收；READ_HOSTS 仍为空。发布版本、验证范围与限制见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 执行架构

官方 API 以安装包中 `agents/docs/harnesses/pi.md`、`docs/lifecycle.md`、`docs/models-pi-ai.md` 和 `.d.ts` 核对。Pi 工厂传递 onWake；Lifecycle 管理恢复、任务监督和清理作业，共用物理 alarm。公开 npm `pi-web-access@0.47.0` 的 TinyFish 源码用于核对 query/page、批量 urls/markdown 及 results[].text 合同，没有复制整份插件或其宿主依赖。

每个会话一个 SQLite Durable Object；每次提交一个 run。先保存任务与恢复作业，再以 run ID 持久提交 Pi。进程在提交前后中断时重放相同 operationId。任务在 202 返回前已提交 Pi；断开 HTTP 只停止等待。独立 RequestKey DO 在分配会话前持久保存幂等键映射，因此首次响应丢失也能找到原任务。

当前默认模型 `deepseek-flash`，通过 `AI_GATEWAY_ID=deepseek` 使用网关中 DeepSeek provider 的 `default` BYOK 密钥。该路径走 provider-native 接口，不经过 Workers AI `/run` 的付费模型目录，也不回退到 Cloudflare 统一计费。保留 `@cf/` Workers AI 模型支持，使用 GLM-5.3 Flash 仍需相应付费资格。

最多 8 个工具轮次，总预算 5 分钟。deadline 存于任务中；工具共享剩余预算，监督作业在到期时取消 Pi。完成时再次检查截止，只有 Pi `done` 可返回 succeeded；unanswered、turn_limit、取消、超时均没有 completion。SSE 执行中只有心跳，完成后发送最终正文、finish、可选累计 usage 和 `[DONE]`；失败发送 error 与 `[DONE]`，不伪造成功。

会话最后一次提交/查询/取消后 7 天清理。幂等键保存 7 天（从首次映射计算）；到期后同键是新请求。键映射先于任务 admission 保存，若 admission 返回 409，原键仍保留，稍后可重试。失败运行的 Pi 转录仍属于会话，客户端如需完全隔离失败上下文应创建新会话。

## 配置与部署

需要 Node 22.19+、支持 DO SQLite 的 Cloudflare 账户、AI Gateway/Workers 部署权限，以及网关中的有效 DeepSeek BYOK 密钥；模型费用由所选上游账户承担。凭证通过 Cloudflare Secrets 输入，不写进仓库或聊天：

```sh
git clone --branch Cloudflare --single-branch https://github.com/yantze/picall.git
cd picall
npm ci
npm run check
npm test
npm run build                    # deploy --dry-run，不部署
npx wrangler login               # 或在 CI 配置 scoped Cloudflare token
npx wrangler secret put API_BEARER
npx wrangler secret put BRAVE_KEY
npx wrangler secret put TAVILY_KEY
npx wrangler secret put TINYFISH_KEY
# 显式启用 Exa 才需 EXA_KEY；Jina 如有服务 key 可设 JINA_KEY
npx wrangler deploy
```

部署前编辑 `wrangler.jsonc` 的 READ_HOSTS。它是 JSON 字符串数组，精确匹配可信公网 HTTPS 主机，例如 `["developers.cloudflare.com","github.com"]`；默认空数组会拒绝所有正文读取。配置必须只包含你信任、稳定解析到公网的站点；不允许通配符、IP 字面量、非 443 端口、用户名密码或 HTTP。HTTP fallback 每次跳转重新检查白名单，最多 5 次请求。TinyFish 返回的 final_url 也会检查。

**首版访问边界**：这是可信主机白名单模式，尚不支持安全地读取任意搜索命中的域名。Worker 没有沿用本地 node:dns，白名单也不是 DNS 重绑定防护。Jina/TinyFish 的服务内部跳转受各自远端策略控制，本 Worker 无法逐跳观察；需要严格逐跳地址控制的部署须配置具备该保证的抓取代理后再扩大访问面。搜索可返回白名单外的 URL，但 fetch_content 会明确拒绝。不要把任意用户提交的域名自动加到白名单。

BRAVE_BASE_URL 默认 `https://brave.vastiny.com/res/v1`，TAVILY_BASE_URL 默认 `https://tavily.vastiny.com`。密钥仅加入对应服务请求头；页面读取和自定义工具不会收到搜索密钥。Jina key 仅用于 r.jina.ai。自定义 base URL 是部署方的可信配置，不能来自客户端或模型参数。

已通过 Cloudflare 插件发布 Worker 并配置独立 API_BEARER；第三方搜索密钥尚未配置，真实模型和搜索调用尚未验收。当前开发环境仍限制 workers.dev 出站请求，因此发布后的 HTTP 验收尚未完成。部署环境需允许 Cloudflare API/Workers AI、上述两个搜索代理、api.search.tinyfish.ai、api.fetch.tinyfish.ai、api.exa.ai（可选）、r.jina.ai，以及 READ_HOSTS 目标和允许的跳转域名。云端开发环境的出站白名单和部署 Worker 的网络是两回事。

## API

所有接口必须带 `Authorization: Bearer <API_BEARER>`。不提供管理路由。API key 是整个部署的访问边界，当前没有多租户用户隔离；持有 key 的调用方可以访问其他 run ID。

| 接口 | 输入/输出 |
| --- | --- |
| GET /v1/models | 唯一部署允许的 model，当前为 deepseek-flash |
| POST /v1/chat/completions | 文本 messages；JSON 或 stream:true 的 SSE |
| POST /v1/runs | `{ "prompt": "…", "model": "可选" }`；202 + id/session_id |
| GET /v1/runs/{id} | 状态；成功含 completion；失败含 error；usage、elapsed_ms、service_calls |
| POST /v1/runs/{id}/cancel | 显式取消；重复取消返回原终态 |

提交可带 X-Session-Id 与 Idempotency-Key，响应带 X-Session-Id、X-Run-Id。未提供会话时独立创建；未提供幂等键时每次新建 run。同会话活动运行期间新提交为 409。续接可只发下一个 user，也可发完整且不变的历史加 user；修改历史、system 或 model 返回 409。消息最多 500 条，请求体最多 1 MiB，仅接受文本和文本 content parts。模型默认部署 MODEL；客户端指定其他模型为 404。忽略合法 temperature（保持模型默认），其余不支持的采样/工具参数明确拒绝。

客户端可省略 model 使用部署默认值，或填写 `"model":"deepseek-flash"`。切换模型后请新建会话；带旧模型的完整会话历史会返回 409，显式传旧 GLM 模型会返回 404。

```sh
curl "$PICALL_URL/v1/runs" \
  -H "Authorization: Bearer $PICALL_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: research-example-1' \
  -d '{"prompt":"搜索并阅读多个来源，比较 Workers 和 Durable Objects 的执行限制，附来源链接。"}'
# 保存返回的 id；网络断开后仍可 GET /v1/runs/{id}
```

JSON 等待连接可能被调用方或中间代理超时关闭，使用异步 runs API 更适合长任务。应用没有把 HTTP 断线当取消。当前不开放跨域浏览器 CORS；服务器客户端不受影响。

## 工具合同

- `web_search({query, provider?, count?, page?, domains?, freshness?})`：count 1–20，page 1–10（外部 provider 仍有自己的分页上限）；freshness 为 Brave 风格 pd/pw/pm/py。默认严格 Brave → Tavily → TinyFish。网络/读取错误、超时、408/425/5xx、402/429/432 切换；缺凭证、401/403、参数或配置错误直接失败。合法空结果不切换。显式 provider 只用该服务，包括 Exa；没有免费 MCP fallback。Tavily/Exa 暂只支持 page=1，其他分页明确返回错误；freshness 分别映射为 time_range 和 startPublishedDate。domains 支持以 - 前缀排除域名，所有结果再按域名过滤。TinyFish page 映射至从零开始的外部分页，单页服务最多约 10 条，返回量可能小于 count。
- `fetch_content({url})`：Jina → TinyFish → HTTP；远端失败、超时、无正文进入下一项；安全限制、超限、不支持的类型、取消和总截止停止。正文最多 2 MiB；HTTP HTML 使用轻量文本提取，非浏览器级可读性解析。工具响应初始正文最多 20,000 字符，完整正文存在 run 的 SQLite 中。
- `get_search_content({search_id?,result_id?,content_id?,find?,offset?,limit?})`：查询编号来源、按结果号读取正文、正文分页和大小写不敏感查找。find 未命中时 found=-1。ID 只在当前 run 有效，不跨 run 隐式共享。

抓取都作为 Pi 管理的工具执行，没有无人等待的后台 fetch Promise。工具注册 replay:safe 表示可重放，不表示第三方计费 exactly-once。模型可能并行调用工具；服务调用次数序列化写入，记录的是发出网络请求前的尝试次数，包括失败和可能未真正送达的请求。

HTTP_TOOLS 是仅部署时配置的 JSON 数组，不接受客户端上传插件或代码。每项包括 name、description、parameters（JSON Schema object）、url。工具执行固定 HTTPS GET，把已校验参数编码为 query，目标必须在 READ_HOSTS，拒绝所有重定向。没有动态路径、任意请求头、密钥访问或代码执行。例如：

```json
[{"name":"lookup_status","description":"Read public service status","url":"https://status.example.com/api","parameters":{"type":"object","properties":{"service":{"type":"string"}},"required":["service"],"additionalProperties":false}}]
```

权限边界由服务端代码执行。提示词要求把网页作为外部资料，不能将其当作权限或读取凭证的指令。

## 模型与网关配置

普通文本变量 `MODEL=deepseek-flash`、`AI_GATEWAY_ID=deepseek`；DeepSeek 还支持已安装模型表中的 `deepseek-v4-pro`。密钥存于 Cloudflare AI Gateway 的 DeepSeek provider，alias 为 `default`，不复制到 Worker Secret 或源码。单次模型请求输出上限为 8192 token。Workers AI `@cf/` 模型仍通过同一 AI binding 使用；不要把网关 ID 当作模型 ID。

`npm run types` 从 Wrangler 配置生成绑定类型，`npm run check` 检查生成文件同步和 TypeScript。Worker 已开启运行日志及少量请求追踪；不记录 API 密钥或提示词正文。

## 用量、恢复和升级

Pi 的 usage 是会话累计值，run 在首次提交前保存基线，再在终态取差值；包含整个循环及 Pi 记录的失败尝试，不只最后一轮。API 返回 OpenAI token 总量和各模型差值、模型目录估价、各服务请求尝试次数及总耗时。目录估价不等同账单；DO 计算/存储费用及真实搜索账单须结合 Cloudflare 与服务商报表核对。不要用 elapsed_ms 直接计算 DO CPU 费用。

Pi 仍实验性，lockfile 固定版本。更新 storage 格式后不要假定旧 Worker 能回读，升级前备份、跑恢复验收，优先向前修复。会话状态和正文受七天保留策略约束，不是永久归档。

验证结果及真实联调清单见 [VALIDATION.md](VALIDATION.md)。
