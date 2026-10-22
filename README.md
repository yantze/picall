# PiCall

把 **Pi coding agent 作为 LLM 服务**。本地安装一个 npm 包即可启动 OpenAI 兼容 API，以及无需登录的中文管理页面。

```text
外部应用 → /v1/chat/completions → 会话管理 → pi --mode rpc
                                          └→ 模型 + 工具循环 → JSON / SSE
```

- OpenAI 风格的 `/v1/models`、`/v1/chat/completions`，支持 JSON 和 SSE 流式响应。
- 客户端逐请求指定 `model` 和 `reasoning_effort`，PiCall 不保存模型默认值。
- 从 Pi 查询可用模型及其推理级别、上下文窗口和最大输出长度，页面只读展示。
- `/v1/*` 可配置 Bearer API key；本地管理页无需登录。
- 独立日志标签页、实时事件、过滤搜索、会话查看与关闭；试运行显示工具加载清单和实际调用状态。
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
# 或 npm pack 后 npm install -g ./yantze-picall-0.2.0.tgz
```

启动后打开终端输出的本地管理地址，默认端口 **8787**。管理页保存 API key、会话和项目设置；Pi 模型目录只读展示能力。试运行页作为一个客户端，选择仅用于本次请求的模型和推理强度，不保存为服务默认值。日志入口可在新标签页中打开。

显式指定 `--workdir` 即视为信任该项目，自动加载其 Pi 项目配置、扩展和 MCP，无需额外信任参数。

`@yantze/picall` 是包名，目前未发布到 npm registry；不要使用 registry 安装命令，直到单独完成发布。

也可在启动前设置 Pi 支持的提供商环境变量，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`，或使用自定义 `~/.pi/agent/models.json`。这些是**上游模型凭据**；管理页设置的 PiCall API key 是**外部应用访问本服务的凭据**，二者独立。页面不会读取或编辑上游凭据。

```bash
picall --port 8787 --data-dir /absolute/path/to/picall-data --workdir /your/project
picall --help
picall pi --version
```

配置和运行日志默认存放在 `~/.picall`，可用 `--data-dir` 或 `PICALL_DATA_DIR` 修改。配置包含本服务 API key，文件以 `0600` 权限保存。日志只记录请求 ID、会话、模型、工具名称、用量和状态，不记录 prompt、模型正文、工具参数或 API key；最多保留当前和上一个约 5 MiB 日志文件。实时页面保留最近 1000 条事件。

## 调用 API

在页面生成或填写 API key 后点击保存。未设置 key 时，API 接受同机调用。先通过 `/v1/models` 查询 Pi 的可用模型，再把返回的完整 `provider/model` ID 放进每次请求的 `model` 字段。下面的 `YOUR_PROVIDER/YOUR_MODEL` 需替换为实际 ID。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer YOUR_PICALL_KEY'

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_PROVIDER/YOUR_MODEL","messages":[{"role":"user","content":"检查当前项目并说明结构"}]}'

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_PROVIDER/YOUR_MODEL","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"列出当前目录"}]}'
```

OpenAI Python SDK（`pip install openai`）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="YOUR_PICALL_KEY")
response = client.chat.completions.create(
    model="YOUR_PROVIDER/YOUR_MODEL",
    messages=[{"role": "user", "content": "读取 README，概括这个项目"}],
)
print(response.choices[0].message.content)
```

### 查询模型和能力

`GET /v1/models` 只返回 Pi 认为可用的真实模型，不再提供人工 `pi` 别名。`GET /v1/models/{provider/model}` 返回单个模型，同样受 API key 保护。

```json
{
  "object": "list",
  "data": [
    {
      "id": "your-provider/your-model",
      "object": "model",
      "created": 0,
      "owned_by": "your-provider",
      "name": "Your Model",
      "context_window": 131072,
      "max_output_tokens": 8192,
      "reasoning": true,
      "supported_reasoning_efforts": ["off", "minimal", "low", "medium", "high"],
      "input_modalities": ["text"]
    }
  ]
}
```

标准的 OpenAI 模型字段保持兼容，其余为能力扩展字段，客户端可按需读取。实际数值来自 Pi 的模型列表；推理级别使用与 Pi RPC 相同的能力判断函数，考虑模型的 thinkingLevelMap，不会为每个模型切换会话或改写 Pi 设置。不同客户端可以并发选择不同模型和 effort。

```json
{
  "model": "your-provider/your-model",
  "reasoning_effort": "high",
  "messages": [{"role": "user", "content": "分析这个项目"}]
}
```

### 多轮会话

每次响应通过 `X-Session-Id` 返回会话 ID。后续请求带上该 header，仅传下一条 user 消息即可。也可从第一轮开始自行指定一个 ID（1–128 个字母、数字、点、下划线、连字符）。同一会话的请求必须串行；并发返回 `409`。也支持传入完整历史，但历史必须与前一次响应完全一致，不能静默改写已存在的上下文。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PICALL_KEY' \
  -H 'X-Session-Id: my-project-chat' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_PROVIDER/YOUR_MODEL","messages":[{"role":"user","content":"继续，运行项目测试"}]}'
```

不带会话 header 的请求每次创建新会话；会话只在服务进程内保留，重启后不恢复。默认最多 8 个会话，空闲 30 分钟回收；达到容量时优先回收最久未用的空闲会话，全部繁忙时返回 `503`。已回收的会话 ID 返回 `409`，需要新 ID。修改模型、显式 reasoning effort 或 system prompt 后应新建会话；续聊省略 reasoning effort 会沿用该会话的初始选择。页面可主动关闭会话。默认请求超时 300 秒，可通过本地配置 API 的 `requestTimeoutSeconds` 调整。

### 兼容范围

支持文本 `system`、`developer`、`user`、`assistant` 消息、文本 content 数组、`stream`、`stream_options.include_usage`、`n=1`、`reasoning_effort`。system/developer 内容追加到 Pi 自带的 agent system prompt；Pi 的工具和执行能力仍然启用。返回的文本包含本轮 agent 的各次助手文本，工具循环结束后才发出流终止标记。用量累加本轮全部模型调用（包含缓存输入 tokens）。

请求字段 `reasoning_effort` 可选，接受 Pi 公开的 `off / minimal / low / medium / high / xhigh / max`，以模型返回的 `supported_reasoning_efforts` 为准。OpenAI 的 `none` 映射为 Pi 的 `off`。新会话省略或传 null 时，不向 Pi 传入 thinking 参数，使用 Pi 自身的默认值；不会强加 medium。非推理模型通常只支持 off，不支持的级别返回 400。

上下文窗口是 Pi 模型配置的容量元数据，不是 OpenAI Chat Completions 的标准请求参数。PiCall 返回该信息，不再提供服务端窗口覆盖或改写 Pi 的模型；如需更改模型定义，请在 Pi 的 models.json 中配置。`context_window` / `contextWindow` 请求字段会明确返回 400，避免误以为改变了模型容量。最大输出长度同样作为模型能力返回；当前 RPC 尚未映射逐请求的 max_tokens。

`temperature` 接受 OpenAI 格式的 `0–2` 数字或 `null`，以兼容自动携带该参数的客户端。当前 Pi RPC 不提供逐请求设置 temperature 的命令，因此该字段不会下传，也不会改变 Pi 或上游模型原有的采样设置。

图片/音频、客户端 function calling、`top_p`、`max_tokens`、`max_completion_tokens`、`stop`、`response_format`、logprobs、seed 和 penalties 尚未映射到 Pi RPC；传入时返回 `400`，不会假装生效。工具由 Pi 内部执行，不会作为 OpenAI `tool_calls` 返回给调用端。暂不提供 `/v1/responses` 和 embeddings。

## MCP、Skills、扩展

配置由 Pi 原生管理，PiCall 启动的进程会继承同一用户和工作目录：

- 全局目录：`~/.pi/agent/`；项目目录：工作目录下的 `.pi/`。
- MCP：使用 Pi 的 `mcp.json`（全局或项目级），按 Pi 官方文档配置服务器。
- Skills / extensions：使用 Pi 支持的目录和 `settings.json` 配置。
- Pi packages：`picall pi install <package>`，随后创建新 PiCall 会话加载。

管理页提供服务设置、只读模型目录、试运行及会话管理；MCP 和 packages 的安装配置使用 Pi CLI/配置文件。模型、推理强度由真实客户端逐请求指定。

### 终端 Pi 能联网，试运行却说“没有搜索/浏览工具”？

模型的自述不能代替实际工具诊断。试运行旁会展示 Pi 进程实际加载的工具名称、工作目录和配置目录；执行过程中会展示本轮工具名称和状态，不显示工具参数或输出正文。

Pi 默认的 `read / bash / edit / write` 不含独立网页搜索、浏览工具。`bash` 可以使用本机的 curl 等程序发起 HTTP 请求；专门的搜索、网页抓取能力通常来自你配置的 MCP 或扩展。PiCall 不额外安装搜索服务，也不限制子进程联网；实际访问仍取决于本机网络、工具和凭据。

PiCall 使用内置 Pi，而终端的 `pi` 也可能是其他版本、别名或携带额外 `-e` 参数的包装脚本。请对比 `pi --version` 与 `picall pi --version`，并使用相同工作目录和 `PI_CODING_AGENT_DIR`。已有 PiCall 会话不会自动重载新安装的工具，配置变化后请点击“新会话”。

**指定工作目录即信任项目。** PiCall 将显式的 `--workdir` 视为对该项目的信任，自动向 Pi 传入 `--approve`，加载项目 `.pi` 下的 MCP、扩展和其他受保护配置；它优先于之前保存的 PiCall 信任设置。直接这样启动即可：

```bash
picall --workdir /your/project
```

未指定 `--workdir` 时，PiCall 继续使用已保存的信任设置；首次启动默认为遵循 Pi 自己的信任决定。Pi 1.4 的 RPC 无法显示内置项目信任提示，此时未保存信任决定的项目资源可能被跳过。页面的“项目资源信任”仍可手动调整：

- `default`：遵循 Pi 已保存的信任决定。
- `allow`：信任当前工作目录，允许加载该项目配置、MCP 和扩展；扩展会在 Pi 进程中执行。
- `deny`：忽略项目中的受保护资源。

如需覆盖自动选择，可显式传入 `--project-trust default|allow|deny`；它的优先级高于 `--workdir` 的自动信任，且不受参数顺序影响。例如：

```bash
picall --workdir /your/project --project-trust deny
```

也可以在同一目录运行 `picall pi`，通过 `/trust` 保存 Pi 自己的信任决定。修改加载策略后重新创建 PiCall 会话。指定 `--workdir` 会信任项目，但不会自动批准扩展请求的交互式确认。依赖弹窗选择、输入或确认的扩展仍需适配无交互运行；被取消的请求会记录在日志中。

### 启动时为什么会克隆其他 Git 仓库？

PiCall 自身不会克隆额外的网关仓库。Pi 会解析现有全局或项目 `settings.json` 中的 `packages` 配置，并自动安装缺失的 Git/npm 包；已安装的扩展也可能执行自己的初始化逻辑。因此启动时出现第三方仓库克隆，应先检查这些配置，具体来源需以本机配置和日志为准。

如果希望保留已经安装的扩展，但禁止 Pi 在启动时下载缺失的包，可以使用 Pi 原生的启动离线选项：

```bash
PI_OFFLINE=1 picall --workdir /your/project
# 直接打开 bundled Pi 时同样可使用：
picall pi --offline
```

这会禁用 Pi 的启动网络操作（包括缺失 package 的自动安装），仍允许正常的模型请求。它不屏蔽已安装扩展自行发起的网络操作，也不会删除现有配置。实际全局配置目录受 `PI_CODING_AGENT_DIR` 影响，默认是 `~/.pi/agent`；项目配置位于 `--workdir` 下的 `.pi`。不要公开完整配置文件，其中可能包含凭据。

## 从 0.1.x 升级

0.2.0 移除 PiCall 保存的 model、effort 和 contextWindow。读取旧配置时会忽略这些字段，保留 API key、会话、目录与信任设置；下一次保存服务设置时会清除旧字段。管理 API 不再接受写入模型参数。

调用端必须传入 `/v1/models` 中的真实模型 ID，旧 `model: "pi"` 别名和省略 model 的用法不再支持。试运行的模型和推理选项仅属于页面本次请求，刷新页面后恢复为未指定 effort，不影响其他客户端。

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
