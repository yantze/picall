# Workers 发布记录

## 当前部署：自动平衡研究性能优化

发布时间：2026-11-08 09:38:22（Asia/Shanghai）。

- 源码提交：`86d530f50267d8e1c10aa8c498994482f942ccba`（Cloudflare 分支）。
- Worker version：`af4fb00d-0c81-4a31-b450-6f99c3601ff7`。
- Deployment：`bb49627b-20b0-451b-806d-b80ec0e941de`，流量 100%。
- 服务地址：https://picall-agent-search.vastiny.workers.dev
- 简单问题优先一次搜索和少量来源，复杂问题继续补查；默认 3 条结果、600 字符摘要、6,000 字符正文预览、4,000 字符默认分页，完整正文仍可查找/分页。
- 明确的人机验证/拒绝访问页面进入 reader fallback；同 run 的重复搜索与网页读取使用持久缓存，并发重复请求合并，各等待者独立取消。
- JSON/SSE 从外层每秒轮询改为内部最长 15 秒的 PiHarness.wait；等待不持有会话锁，Lifecycle 继续监督与恢复。增加不含查询、正文和凭证的性能日志。
- 33 项自动测试（含 6 个 workerd 集成场景）、生成类型同步、TypeScript 和 minified 生产 dry-run 通过。
- 所有线上绑定按名称继承；原有 API_BEARER/搜索 Secrets、DeepSeek 网关、两个 DO namespace、兼容日期与日志设置保留，migration tag 仍为 v1。
- bundle：1,117,553 bytes；SHA-256：`5c9e0802ff12ff8f87c7f68006c421b6b800a2b3cad7f7f5f843fbc1ad21b659`。

本轮真实云端探针正在采集三次天气和一次复杂研究的结果。探针仅有 scheduled handler，通过已有 namespace 调用线上 DO，没有公网 HTTP 路由或密钥绑定；验证结束后删除。它不替代公网 API 入口和客户端端到端网络耗时测试。

## 搜索修复与不限地址读取（历史）

发布时间：2026-11-08 02:34:19（Asia/Shanghai）。

- 源码提交：`11cc290ec639756fb91a33282f26cbadf6118372`
- Worker version：`8b848067-fb04-4a0f-8581-f31a7ea3e896`
- Deployment：`65c33e3a-9ce8-403d-9aeb-a71f8d85ff5b`，流量 100%。
- 服务地址、DeepSeek 模型/网关、API_BEARER 和搜索 Secrets 保持原配置。
- 修复把全局 fetch 绑定到 WebTools 实例而引发的请求接收者错误；真实 workerd 回归已验证修复前没有出站请求，修复后收到预期请求。
- 按用户要求取消域名、IP、端口白名单，允许所有 HTTP/HTTPS 网页地址及跨站重定向；线上 READ_HOSTS 已删除。保留 URL 解析/协议、响应大小、跳转次数、总截止与取消控制。
- 增加不含密钥/查询正文的 provider/status 诊断、搜索 fallback 轨迹，以及 Asia/Shanghai 日期上下文和避免重复尝试已耗尽 provider 的提示。
- 26 项自动测试、生成类型同步、TypeScript 和生产 dry-run 通过；真实天气搜索/读取仍待调用方重发请求验收。
- bundle SHA-256：`8c8e1c95206db99df9fd9edb908cac1d2816030a873879bce1e0211406d20f7f`。

## DeepSeek BYOK 接入记录（历史）

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

23 项本地自动测试、绑定类型同步检查、TypeScript 和生产 dry-run 均通过；其中包括 DeepSeek 原生路径、凭证不外传、禁止统一计费、模型引用恢复及完整工具循环 JSON/SSE。Cloudflare API 已核对以上部署和绑定信息。开发执行环境仍无法直接访问 workers.dev；调用方随后提供的真实 JSON ping 已成功返回，验证了 Worker → deepseek 网关 → DeepSeek 模型链路。

调用方应省略 model 使用部署默认值，或显式发送 `"model":"deepseek-flash"`。不要继续传旧的 GLM 模型 ID；模型切换后请使用新会话。旧失败 run 不会因配置更新自动重跑。

## 真实模型验收

2026-11-08，调用方使用现有 API 鉴权向 `/v1/chat/completions` 发送 ping，返回最终回答与 `finish_reason=stop`，模型用量桶为 `deepseek/deepseek-flash`：

- prompt_tokens：677
- completion_tokens：38
- total_tokens：715

这验证了实际 Worker 的鉴权、Pi 执行、DeepSeek 网关调用和非流式 JSON 完成响应。响应里的 `cost.total=0.0002487` 标注为 `catalog_estimate`，属于模型目录估价，不等于服务商账单。

真实搜索、网页读取、多来源研究，以及线上 SSE、断线恢复、取消仍待验收；23 项本地自动测试的 mock 结果与上述真实 ping 分开记录。搜索 Secrets 已配置但尚未验证有效性，网页读取地址限制已按用户最新指令取消（见当前修复记录）。

## 首次发布历史：Workers AI

首次发布时间：2026-11-08 01:35:51（Asia/Shanghai）。源码 `899667768d9722137ea04ac616824589099905eb`，Worker version `3d12f7bf-677c-441e-8cfa-4c21c5340024`，deployment `8bddb21e-546d-414d-97d5-2d5162ca1685`。当时默认模型 GLM-5.3 Flash 在当前 Workers Free 套餐返回 403 / 5035，因此随后按用户要求改为 DeepSeek BYOK；该旧版本现已被替换。

API_BEARER 不在 Git 中。初始生成值的交付文件仅存在于云端工作区被忽略的 `.wrangler/publish/API_BEARER.txt`；如已在控制台重设，应使用新值。不要把真实密钥提交到仓库或聊天。
