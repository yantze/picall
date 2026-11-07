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

23 项本地自动测试、绑定类型同步检查、TypeScript 和生产 dry-run 均通过；其中包括 DeepSeek 原生路径、凭证不外传、禁止统一计费、模型引用恢复及完整工具循环 JSON/SSE。Cloudflare API 已核对以上部署和绑定信息。开发执行环境仍无法直接访问 workers.dev；调用方随后提供的真实 JSON ping 已成功返回，验证了 Worker → deepseek 网关 → DeepSeek 模型链路。

调用方应省略 model 使用部署默认值，或显式发送 `"model":"deepseek-flash"`。不要继续传旧的 GLM 模型 ID；模型切换后请使用新会话。旧失败 run 不会因配置更新自动重跑。

## 真实模型验收

2026-11-08，调用方使用现有 API 鉴权向 `/v1/chat/completions` 发送 ping，返回最终回答与 `finish_reason=stop`，模型用量桶为 `deepseek/deepseek-flash`：

- prompt_tokens：677
- completion_tokens：38
- total_tokens：715

这验证了实际 Worker 的鉴权、Pi 执行、DeepSeek 网关调用和非流式 JSON 完成响应。响应里的 `cost.total=0.0002487` 标注为 `catalog_estimate`，属于模型目录估价，不等于服务商账单。

真实搜索、网页读取、多来源研究，以及线上 SSE、断线恢复、取消仍待验收；23 项本地自动测试的 mock 结果与上述真实 ping 分开记录。搜索 Secrets 已配置但尚未验证有效性，READ_HOSTS 仍需按可信来源设置。

## 首次发布历史：Workers AI

首次发布时间：2026-11-08 01:35:51（Asia/Shanghai）。源码 `899667768d9722137ea04ac616824589099905eb`，Worker version `3d12f7bf-677c-441e-8cfa-4c21c5340024`，deployment `8bddb21e-546d-414d-97d5-2d5162ca1685`。当时默认模型 GLM-5.3 Flash 在当前 Workers Free 套餐返回 403 / 5035，因此随后按用户要求改为 DeepSeek BYOK；该旧版本现已被替换。

API_BEARER 不在 Git 中。初始生成值的交付文件仅存在于云端工作区被忽略的 `.wrangler/publish/API_BEARER.txt`；如已在控制台重设，应使用新值。不要把真实密钥提交到仓库或聊天。
