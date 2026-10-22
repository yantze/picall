# PiCall

把 **Pi coding agent 作为 LLM 服务**。本地安装一个 npm 包即可启动 OpenAI 兼容 API，以及无需登录的中文管理页面。

```text
外部应用 → /v1/chat/completions → 会话管理 → pi --mode rpc
                                          └→ 模型 + 工具循环 → JSON / SSE
```

- OpenAI 风格的 `/v1/models`、`/v1/chat/completions`，支持 JSON 和 SSE 流式响应。
- 页面选择 `provider/model`、reasoning effort 和 context window，配置持久保存。
- `/v1/*` 可配置 Bearer API key；本地管理页无需登录。
- 独立日志标签页、实时事件、过滤搜索、会话查看与关闭。
- 一个会话一个 Pi 子进程，支持 `X-Session-Id` 保留工具调用和多轮上下文。
- 使用 Pi 原生模型认证、MCP、extensions、skills 和 Pi packages。

## 安装与启动

需要 **Node.js ≥ 22.19.0**。当前通过 GitHub 安装，不需要额外全局安装 Pi：

```bash
npm install -g github:yantze/picall
picall pi
# 在 Pi 中输入 /login 完成模型提供商登录，再退出 Pi。
picall --workdir /absolute/path/to/your/project
```

也可以从已检出的仓库安装：

```bash
npm ci
npm start -- --workdir /absolute/path/to/your/project
# 或 npm pack 后 npm install -g ./yantze-picall-0.1.0.tgz
```

启动后打开终端输出的本地管理地址，默认端口 **8787**。先刷新模型列表、选择模型，按模型能力设置 effort，然后保存。页面的日志入口可在新标签页中打开。

`@yantze/picall` 是包名，目前未发布到 npm registry；不要使用 registry 安装命令，直到单独完成发布。

也可在启动前设置 Pi 支持的提供商环境变量，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`，或使用自定义 `~/.pi/agent/models.json`。这些是**上游模型凭据**；管理页设置的 PiCall API key 是**外部应用访问本服务的凭据**，二者独立。页面不会读取或编辑上游凭据。

```bash
picall --port 8787 --data-dir /absolute/path/to/picall-data --workdir /your/project
picall --help
picall pi --version
```

配置和运行日志默认存放在 `~/.picall`，可用 `--data-dir` 或 `PICALL_DATA_DIR` 修改。配置包含本服务 API key，文件以 `0600` 权限保存。日志只记录请求 ID、会话、模型、工具名称、用量和状态，不记录 prompt、模型正文、工具参数或 API key；最多保留当前和上一个约 5 MiB 日志文件。实时页面保留最近 1000 条事件。

## 调用 API

在页面生成或填写 API key 后点击保存。未设置 key 时，API 接受同机调用。`model: "pi"` 使用页面保存的默认模型；也可以传 `/v1/models` 返回的完整 `provider/model` ID。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer YOUR_PICALL_KEY'

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"pi","messages":[{"role":"user","content":"检查当前项目并说明结构"}]}'

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"pi","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"列出当前目录"}]}'
```

OpenAI Python SDK（`pip install openai`）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="YOUR_PICALL_KEY")
response = client.chat.completions.create(
    model="pi",
    messages=[{"role": "user", "content": "读取 README，概括这个项目"}],
)
print(response.choices[0].message.content)
```

### 多轮会话

每次响应通过 `X-Session-Id` 返回会话 ID。后续请求带上该 header，仅传下一条 user 消息即可。也可从第一轮开始自行指定一个 ID（1–128 个字母、数字、点、下划线、连字符）。同一会话的请求必须串行；并发返回 `409`。也支持传入完整历史，但历史必须与前一次响应完全一致，不能静默改写已存在的上下文。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'X-Session-Id: my-project-chat' \
  -H 'Content-Type: application/json' \
  -d '{"model":"pi","messages":[{"role":"user","content":"继续，运行项目测试"}]}'
```

不带会话 header 的请求每次创建新会话；会话只在服务进程内保留，重启后不恢复。默认最多 8 个会话，空闲 30 分钟回收；达到容量时优先回收最久未用的空闲会话，全部繁忙时返回 `503`。已回收的会话 ID 返回 `409`，需要新 ID。修改模型、effort、context window 或 system prompt 后应新建会话。页面可主动关闭会话。默认请求超时 300 秒，可通过本地配置 API 的 `requestTimeoutSeconds` 调整。

### 兼容范围

支持文本 `system`、`developer`、`user`、`assistant` 消息、文本 content 数组、`stream`、`stream_options.include_usage`、`n=1`、`reasoning_effort`。system/developer 内容追加到 Pi 自带的 agent system prompt；Pi 的工具和执行能力仍然启用。返回的文本包含本轮 agent 的各次助手文本，工具循环结束后才发出流终止标记。用量累加本轮全部模型调用（包含缓存输入 tokens）。

effort 支持 `off / minimal / low / medium / high / xhigh / max`，以具体模型支持的级别为准。非推理模型请选 `off`；不支持的级别会明确报错。

context window 留空使用模型默认值；填写数字会通过 Pi 的公开 extension API 设置当前进程的模型上下文预算，影响 Pi 的压缩和上下文管理。它**不会扩大提供商实际允许的上下文长度**，请填写该模型确实支持的值。无论是否自定义，都保留模型原有认证和工具能力。

图片/音频、客户端 function calling、`temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`stop`、`response_format`、logprobs、seed 和 penalties 尚未映射到 Pi RPC；传入时返回 `400`，不会假装生效。工具由 Pi 内部执行，不会作为 OpenAI `tool_calls` 返回给调用端。暂不提供 `/v1/responses` 和 embeddings。

## MCP、Skills、扩展

配置由 Pi 原生管理，PiCall 启动的进程会继承同一用户和工作目录：

- 全局目录：`~/.pi/agent/`；项目目录：工作目录下的 `.pi/`。
- MCP：使用 Pi 的 `mcp.json`（全局或项目级），按 Pi 官方文档配置服务器。
- Skills / extensions：使用 Pi 支持的目录和 `settings.json` 配置。
- Pi packages：`picall pi install <package>`，随后创建新 PiCall 会话加载。

页面第一版提供模型、推理、上下文、API key 和会话管理；MCP 和 packages 的安装配置使用 Pi CLI/配置文件。

## 本地运行边界

管理页按要求免登录，因此服务仅允许 `127.0.0.1`、`localhost`、`::1` 监听，并校验 Host 和管理 API 的同源访问。API key 保护 `/v1/*`；跨源浏览器调用须先配置 key。请勿把免登录管理页通过反向代理公开。

Pi 拥有启动用户的本地工具权限，可在 `--workdir` 中读写文件、执行命令。API 调用会驱动真实 agent；只向可信调用端提供 key。PiCall 不是容器沙箱，不提供 Piper 的每会话容器隔离。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm run dev -- --data-dir /tmp/picall-dev --workdir "$PWD"
npm pack --dry-run
```

测试包含 HTTP/认证/SSE/会话和进程错误处理，以及使用**真实 bundled Pi** 连接本地 OpenAI fixture、执行真实 bash 工具并完成第二轮模型请求的测试；不需要云模型凭据。它验证工具循环与协议，不替代真实提供商账户的联网验证。

此项目参考 [ALange/Piper](https://github.com/ALange/Piper) 的 RPC 网关架构独立实现。依赖和许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。
