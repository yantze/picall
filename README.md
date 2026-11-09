# PiCall · 本地 Durable Agent Search

在本机通过网页配置模型、搜索服务和只读 HTTP 工具，再用 OpenAI 兼容 API 发起研究任务。执行层直接使用 **Pi Durable 1.5.0 + 本地 SQLite**；任务在进程重启后按检查点恢复。

`main` 是本地版；[`Cloudflare` 分支](https://github.com/yantze/picall/tree/Cloudflare)保留独立的 Workers / PiHarness 版本。本地版不依赖 Cloudflare 账号，也不加载 Coding Agent、外部 Pi 插件、MCP、Skills、文件或命令工具。

## 启动与配置

需要 **Node.js 22.19+**，推荐 Node.js 24。无需构建：

```bash
git clone -b main https://github.com/yantze/picall.git
cd picall
npm ci
npm start
```

打开 **http://127.0.0.1:8787**，进入「服务设置」：

1. 「模型网关」填写 OpenAI 兼容 Base URL、模型 API Key 和模型 ID。默认模型 `deepseek-flash`，默认地址 `https://api.deepseek.com/v1`；自建网关填写它提供的兼容地址和对应密钥。Base URL 不含 `/chat/completions`。模型需要支持工具调用和上游 SSE。
2. 「搜索与网页」填写搜索服务 key。默认 Brave 地址 `https://brave.vastiny.com/res/v1`、Tavily 地址 `https://tavily.vastiny.com`；可改为官方或兼容服务地址，key 必须属于所填写的服务。
3. 保存并新建会话。模型目录显示 `picall/<模型 ID>`，API 也接受短名或省略 model 使用默认值。

「接口 API Key」保护本地 `/v1/*`，与模型、搜索服务的密钥独立。密钥输入留空保留原值，点击清除后保存才删除。GET 配置只返回设置状态和尾码；短密钥完全遮盖。密钥不写入浏览器存储。

配置保存在 `~/.picall/config.json`，包含明文密钥，仅在本机使用。可用 `PICALL_DATA_DIR` 或 CLI `--data-dir` 改位置；Unix 目录为 0700，配置和数据库为 0600。仅允许回环地址监听，并检查 Host、Origin 和浏览器来源标记；从其他网页点击链接进入首页允许正常导航，配置接口继续限制同源。

```bash
npm start -- --port 8788 --data-dir /absolute/path/to/picall-data
```

## API

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY' \
  -d '{"messages":[{"role":"user","content":"今天杭州的天气怎么样？"}],"stream":false}' \
  -w '\nTotal: %{time_total}s\n'
```

未启用本地接口鉴权时可省略 Authorization。

| 接口 | 行为 |
| --- | --- |
| `GET /health` | 服务健康检查 |
| `GET /v1/models`、`GET /v1/models/{id}` | 网页配置模型及其能力 |
| `POST /v1/chat/completions` | 等待 JSON 或最终答案 SSE |
| `POST /v1/runs` | `{ "prompt": "...", "model": "..." }`，持久受理后返回 202 |
| `GET /v1/runs/{id}` | 状态、最终 completion 或安全错误 |
| `POST /v1/runs/{id}/cancel` | 持久取消意图并中止执行 |

支持文本 system、developer、user、assistant 消息。工具由服务端注册，客户端不能上传或执行插件代码。reasoning_effort 可省略或传 null、none、off；本版配置模型不开放其他推理强度。temperature 为兼容字段，校验后沿用模型默认；其他未支持的采样或客户端工具参数明确拒绝。

返回 `X-Session-Id` 和 `X-Run-Id`。同一会话可以只发下一条用户消息，也可以发送原样完整历史加新消息；历史不匹配、同会话并发或执行配置变化返回 409。对话和历史指纹会持久化，重启后可续接。失败、取消或手动结束的会话需要新建会话。

带 `Idempotency-Key` 可重试同一业务请求：同内容复用任务，不同内容返回 409；即使首次未收到 session ID 也能复用。JSON 与 SSE 的传输偏好不改变任务身份。已完成任务的回放不重新解析当前模型，因此修改模型或清除凭证后仍能查询旧结果。

HTTP 断开只停止等待，后台任务继续。取消须调用取消接口；网页「停止」会显式取消。页面记住最近的任务 ID，可在「查询或恢复查看任务」中查看进度和结果；只在浏览器存储任务 ID，不存密钥。

## 完成与恢复语义

JSON 和 SSE 的正文**只包含确认完成的最终答案**。SSE 执行期间发心跳，完成后输出答案、finish_reason 和 `[DONE]`；`stream_options.include_usage:true` 追加用量。输出耗尽、空答案、unanswered、模型错误、取消、超时和轮数耗尽都返回失败。

- 默认 8 个工具轮次，映射 Durable `maxTurns`：第 8 轮工具运行后仍无最终答案就失败，不自动追加新 run 绕过限制。
- 默认期限为受理后 300 秒；重启和重试不会重置。恢复前先处理过期、取消和配置变化，再 resume。
- 瞬时模型错误由 Durable 最多额外重试 2 次；适配层不叠加重试。连续崩溃保护为 5 次。
- 默认最多并发 8 个会话。闲置 30 分钟释放句柄，SQLite 会话仍可重新打开；任务结果及幂等记录保留 7 天，完整会话数据库在不活跃 7 天且无运行任务后清理。
- 正常关闭会停止受理并刷盘。进程重新启动才会恢复；SQLite 不会自动拉起程序，需要时使用自己的进程服务管理器。

每个会话一个 SQLite 文件，全局索引也是 SQLite。索引先保存固定 run/session ID 和待提交输入，再在 Durable commit 中保存应用元数据并以 `requestId=runId` 提交，最后确认索引后返回受理。索引与会话库之间的中断通过恢复记录和持久 requestId 去重修复，不依赖内存 Promise。

数据库使用 WAL、synchronous=FULL。同一数据目录只允许一个写入进程，通过独立 SQLite 生命周期锁实现，进程被杀后由系统释放。运行时数据库不保存上游密钥，只保存配置指纹；运行中使用配置快照，重启时如果模型地址、密钥或工具配置变化，未完成任务失败并要求重新提交，避免把新密钥发送到旧目标。仅修改本地访问鉴权 key 不改变执行配置。

usage 累计整个任务的模型用量，包括缓存 token 和已记录的失败尝试。崩溃前上游尚未报告的用量无法补算，不是精确账单。未完成的模型或 HTTP 工具调用可能在恢复时重试，第三方服务可能重复计费；已提交的工具结果及最终答案会复用。

## 研究工具

| 工具 | 能力 |
| --- | --- |
| `web_search` | 默认 3 条；provider、分页、时间及域名过滤 |
| `fetch_content` | HTTP/HTTPS 正文读取，返回正文 ID 和最多 6000 字符预览 |
| `get_search_content` | 搜索结果及正文查询、分页、字面子串 find |

搜索严格按 **Brave → Tavily → TinyFish**；Exa 只显式调用。网络、超时、402/408/425/429/432/5xx 触发切换；缺 key、401/403 及参数错误明确失败。合法空结果交给模型调整查询，不切换 provider。

读取严格按 **Jina → TinyFish → HTTP**。Jina key 可选，TinyFish 缺 key 时跳过。验证码、读取器错误页或无正文继续下一项；取消、大小或协议错误停止。允许所有 HTTP/HTTPS 主机，包括内网和回环地址；保留每响应 2 MiB、重定向次数和总期限限制。

保留本轮缓存、相同请求合并、600 字符搜索摘要、长导航跳过、原始正文偏移及错误页识别。搜索结果、全文、调用计数和缓存存入 Durable 应用文档，按 run 隔离，内存只做并发去重。简单问题优先一次搜索和一个权威来源；复杂研究按需补查。系统指令要求将网页视为外部资料，工具不会向模型提供配置密钥。

自定义工具在网页填写 JSON 数组，只执行固定目标的 GET，参数放入查询串，不跟随重定向：

```json
[{"name":"lookup_document","description":"按关键词查询内部文档","url":"http://127.0.0.1:9000/search","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}}]
```

名称使用小写字母开头及小写字母、数字、下划线。核心工具与自定义工具之间不允许重名；工具开关只展示实际注册的研究工具。

## 从 0.7 升级与回滚

停止旧进程后更新 main，运行 `npm ci`、`npm start`。旧配置首次加载时保留一份 `config.v0.7.backup.json`，模型、搜索及本地访问密钥保留；配置版本升级为 2，原生 Pi 选项不再生效。

旧 `runs/*.json` 只读导入索引，保留结果、ID 和幂等映射，原文件不修改。旧未完成任务没有 Durable 检查点，标记 process_interrupted，不自动重跑。旧 Pi 会话不能转换，续接返回 session_expired，需新会话。迁移有版本标记并以事务提交，中断后再次启动不会重复导入。

`picall pi`、workdir、project-trust、session saving、Skills 和 extensions 等旧 CLI 参数会返回迁移说明。本版不读取 `~/.pi` 或其他项目配置。

回滚时停止本版，切换旧代码并恢复备份配置；原 JSON 文件可供旧版继续读取。新 SQLite 文件保留，但新 Durable 任务不能转换为旧 RPC 任务。Pi Durable 存储格式升级需另行验证，不能假设降级兼容。

## 验证

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

测试使用真实 Pi Durable 与 SQLite，模型和搜索上游为本机模拟服务，包括 SIGKILL 恢复测试；浏览器和真实第三方联调的边界见 [VALIDATION.md](VALIDATION.md)。
