# PiCall · 本地 Agent Search

在本机运行 Pi Agent，通过网页配置模型网关、搜索服务和工具，再用 OpenAI 兼容接口调用。无需 Cloudflare 账号或部署 Worker，也无需额外安装搜索插件。

`main` 是本地版；[`Cloudflare` 分支](https://github.com/yantze/picall/tree/Cloudflare)保留已部署的 Workers / PiHarness 版本。两个版本独立运行，密钥不会自动迁移。

## 启动

需要 Node.js **22.19+**，建议使用 Node.js 24 LTS。

```bash
git clone --branch main https://github.com/yantze/picall.git
cd picall
npm ci
npm start
```

打开 **http://127.0.0.1:8787**，进入「服务设置」：

1. 「模型网关」填写 OpenAI 兼容 **Base URL、模型 API Key、默认模型 ID**。例如直连 DeepSeek：`https://api.deepseek.com/v1`、你的 DeepSeek key、`deepseek-chat`。Base URL 不包含 `/chat/completions`。自建网关填写它提供的地址和真实模型 ID，例如 `deepseek-flash`；仅填写网关名称 `deepseek` 不能连接模型。模型要支持工具调用及 OpenAI SSE 上游输出。
2. 「搜索与网页」填写搜索服务的 key。默认顺序是 **Brave → Tavily → TinyFish**，Exa 只供模型显式选择。Brave、Tavily 的 Base URL 可以改为官方地址或兼容代理地址；默认仍使用现有的 `brave.vastiny.com/res/v1` 和 `tavily.vastiny.com`。密钥必须属于对应地址提供的服务。
3. 保存设置，回到概览刷新模型目录并试运行。配置的模型显示为 `picall/<模型 ID>`。也可在 API 中传短名或省略 `model` 使用默认模型。

配置页的「接口 API Key」用于保护本地 `/v1/*`，与上游模型 key、Brave key 等完全独立。密钥输入框留空保留原值；「清除」才删除对应密钥。读取设置只返回配置状态和尾部预览，不返回完整密钥。若已设置接口 key，在网页试运行时也需要输入该 key。

所有配置原子保存到 `~/.picall/config.json`；可用 `--data-dir` 或 `PICALL_DATA_DIR` 改位置。Unix 上配置和任务文件权限为 `0600`，目录为 `0700`。配置文件包含明文上游密钥，仅存本机，不应提交到 Git。网页仅监听本机回环地址，并检查 Host / Origin。

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

未启用本地接口鉴权时可以省略 Authorization。支持文本 `system`、`developer`、`user`、`assistant` 消息；工具由服务端注册，客户端不能上传插件代码或执行任意 `tools`。

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 本地服务健康检查 |
| `GET /v1/models` | 返回配置模型和可用的原生 Pi 模型 |
| `GET /v1/models/{id}` | 查询模型详情 |
| `POST /v1/chat/completions` | 等待结果；支持 JSON 或 `stream:true` SSE |
| `POST /v1/runs` | 提交 `{ "prompt": "...", "model": "..." }`，持久化后返回 202 |
| `GET /v1/runs/{id}` | 查询状态、最终 `completion` 或 `error` |
| `POST /v1/runs/{id}/cancel` | 显式取消执行 |

完成接口返回 `X-Session-Id` 和 `X-Run-Id`。会话续接传 `X-Session-Id`，消息可以只包含下一条用户消息，也可以发送完全一致的历史加新消息。历史冲突、同会话并发或运行配置发生变化返回 409；需要更换模型、密钥或工具配置时新建会话。

提交可带 `Idempotency-Key`：相同 key 和相同内容复用原任务，内容不同返回 409。没有拿到首次响应中的 session ID 也可以用同一个 key 重试。幂等记录随任务保留 7 天，不带 key 每次创建新任务。

**只返回最终答案**。JSON 不拼接中间助手文本；SSE 执行期间发送心跳，答案确认后发送正文、结束标记和可选用量（`stream_options.include_usage:true`）。默认最多 8 个包含工具调用的模型轮次、执行期限 300 秒；轮数或期限耗尽、取消、空答案或输出未完成均作为失败。usage 汇总整次任务的模型调用，包含供应商报告的缓存 token。

HTTP 断开只停止等待，任务继续在本地进程内执行，之后按 run ID 查询；取消必须使用取消接口，网页「停止」会发起取消。完成结果原子保存到数据目录的 `runs/`，保留 7 天，在启动和提交任务时清理。已完成结果可跨进程重启查询；**执行中的 Pi 子进程不具备 PiHarness 的崩溃恢复能力**，重启时任务标记为 `process_interrupted`，需要新任务重试。会话本身默认只驻留内存，重启后使用新的 session ID。为支持结果查询，即使没有开启原生 Pi 会话保存，最终答案仍会写入任务记录。

```bash
curl http://127.0.0.1:8787/v1/runs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: research-example-1' \
  -d '{"prompt":"比较 Durable Objects 与 Workers KV，并引用官方来源"}'

curl 'http://127.0.0.1:8787/v1/runs/RETURNED_RUN_ID'
curl -X POST 'http://127.0.0.1:8787/v1/runs/RETURNED_RUN_ID/cancel'
```

## 内置研究工具

| 工具 | 能力 |
| --- | --- |
| `web_search` | 查询、显式 provider、条数、分页、时间和域名过滤；默认 3 条结果 |
| `fetch_content` | 读取任意 HTTP/HTTPS 页面，返回正文 ID 和最多 6000 字符的预览 |
| `get_search_content` | 根据搜索/正文 ID 取结果、正文分页，或按字面子串 `find` 查找 |

搜索临时网络错误、超时、402/408/425/429/432/5xx 会触发顺序切换；凭证缺失、401/403、参数配置错误明确报错。正常空结果不切换，交给模型调整查询。显式 Exa 只请求 Exa，不使用免费 MCP 替代。

网页读取严格按 **Jina → TinyFish → HTTP**，其中 Jina key 可选；TinyFish 未配置时跳过它。读取器错误页、验证码或无正文进入下一项；取消、超限和协议错误停止。支持所有 HTTP/HTTPS 主机，包括内网和回环地址，保留 2 MiB 响应、重定向次数和执行期限限制。

保留 Cloudflare 版的本轮缓存、相同请求合并、正文持有及分页、长导航跳过、验证码识别。简单问题优先一次搜索和一个权威来源，复杂研究按需扩展。工具缓存按请求隔离，失败不缓存；内置研究工具不向模型暴露配置密钥，系统提示要求将网页当作外部资料处理。原生 Pi 文件读取工具默认仍可用；若仅需搜索，可在「工具策略」关闭文件读取及其他原生工具。工具可安全重试，但第三方服务仍可能重复计费。

「搜索与网页 → 自定义只读 HTTP 工具」支持 JSON 数组，例如：

```json
[
  {
    "name": "lookup_document",
    "description": "根据关键词查询内部文档",
    "url": "http://127.0.0.1:9000/search",
    "parameters": {
      "type": "object",
      "properties": { "q": { "type": "string" } },
      "required": ["q"],
      "additionalProperties": false
    }
  }
]
```

工具名称用小写字母开头，只包含小写字母、数字、下划线；每个工具固定目标 URL，仅发送 GET，参数编码到查询串。不执行上传代码，不跟随自定义工具重定向。

## 原生 Pi 能力

本地执行层沿用仓库固定版本的 Pi 1.4.0 JSONL RPC 和官方扩展 API，不使用 Cloudflare PiHarness。模型与研究配置由应用传给内置扩展，无需手工编辑 `~/.pi`，也不会将模型 key 写入 Pi 的模型配置或认证文件。

原有 Pi provider、MCP、扩展、Skills 和工具逐项开关继续可用。写入和命令执行工具默认关闭，Skills 默认关闭；这些开关不构成操作系统沙箱。内置研究工具与「外部 Pi 扩展」开关独立。可以在网页关闭全部外部扩展，仅使用内置研究能力。

```bash
npm start -- --no-extensions --no-skills --project-trust deny
```

`--workdir DIR` 会显式信任对应项目；不传时使用当前目录及保存的信任策略。保留 `picall pi` 子命令供原生 Pi 登录和配置，`--save-sessions` 供额外保存 Pi 原始会话日志。`--no-save-sessions` 禁止新增原始会话日志，不删除已有日志或任务结果。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

测试使用隔离的临时 Pi 配置目录和本机模拟上游服务，不读取开发者真实 Pi 配置或凭证。真实 Pi + 模拟 OpenAI / 搜索 / HTTP 服务的测试验证工具循环、最终答案、用量、配置变更及工具轮数；网页验收与第三方联调边界见 [VALIDATION.md](VALIDATION.md)。上游 key 不随仓库发布，需要在自己的本地配置页填写。
