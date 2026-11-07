# 验证记录（2026-11-08）

## 已完成的自动验证

在 Cloudflare 分支的独立仓库根目录执行，使用全新安装的锁定依赖；不依赖原仓库的本地执行包。无本地项目迁移、无真实服务凭证。

| 检查 | 结果 |
| --- | --- |
| npm run check | TypeScript 通过 |
| npm test | 26/26 通过（含 5 个 workerd 集成场景） |
| npm run build | Wrangler 生产入口 dry-run 成功；约 2.50 MiB / gzip 500 KiB；仅构建检查；实际发布见 DEPLOYMENT.md |
| git diff --check | 通过 |

分支以单个根提交发布，仅包含 Cloudflare 源码、测试、锁文件、CI、部署文档与 MIT 许可证，不继承旧提交历史。

固定依赖：agents 0.33.0，pi-ai/pi-durable/pi-schema/chord 1.5.0（lockfile）；Wrangler 4.158.0，匹配 Miniflare 5.20261104.0-beta / Workers types 5.20261107.1。研究版本与当前注册表的工具链有差异：原尝试的 Wrangler 4.76.0 本地 workerd 无法向 Lifecycle 提供 DO name，因此更新为实际可用且匹配的工具链。Pi 执行层 API 与交接方案一致。

26 项自动测试覆盖：

- 文本规范化、客户端 tools 拒绝、历史一致性、请求体大小限制；跨模型/轮次用量差值和缓存 token。
- Brave → Tavily → TinyFish 的 429/503 切换，401/403/400 不切换，凭证缺失、合法空结果、显式 Exa、用户取消与任务截止。
- TinyFish 搜索 query/page 与抓取 urls/format/per_url_timeout_ms 合同；时间/域名过滤、排除域名及结果后置过滤。
- Jina → TinyFish 顺序及 HTTP fallback 跨地址跳转、URL 格式/协议、类型与大小限制；持久正文查找；并行工具的请求次数累加；自定义工具名称/目标安全配置拒绝。
- 本地 workerd 使用真实 PiHarness、Pi Durable、Lifecycle 和 SQLite：搜索 → 并行阅读两个来源 → 再搜索 → 最终答案；4 次模型响应共 60 token，brave=2、jina=2；中间助手文本不进入最终 JSON/SSE。
- 独立 Bearer 鉴权、models、202 提交、首次响应之外的幂等重试及不同内容冲突、同会话并发 409、续接与历史冲突、JSON/SSE usage、SSE 读到心跳后断线继续查询、显式取消、turn_limit 没有 completion。
- 使用同一 SQLite 目录销毁并重新创建本地 workerd：完成结果和幂等映射保留；模型/工具尚未完成时关闭运行时后可继续；已存截止时间失效则失败；清理后旧结果 404，原会话名可重新提交。清理由测试直接调用同一清理处理器验证，没有等待真实七天。

这些集成测试的模型是测试代码模拟的 Workers AI SSE 响应，所有搜索和正文 HTTP 都由测试替身返回；它们验证执行与协议合同，不代表真实模型的研究质量、真实网络可达性或第三方合同已在线验收。运行时恢复测试是本地 workerd teardown/reopen，不等同生产 DO 强杀/平台驱逐。测试配置与测试专用控制路由不进入生产入口。

新增 DeepSeek 原生 BYOK 测试：通过持久 provider/model 引用还原模型；强制经 AI.fetch 的 deepseek 网关、default alias，不发送厂商凭证，且携带禁止统一计费回退的请求头。workerd 验证 DeepSeek 模型下搜索/并行读取/补搜、累计用量和最终答案 JSON/SSE。

已实测确认：原 GLM-5.3 Flash 在当前 Workers Free 账户返回 HTTP 403 / 5035；直接调用当前账户的 Llama 3.3 模型成功。调用方随后提供的真实 JSON ping 已通过 DeepSeek 原生网关成功返回，finish_reason=stop，用量为输入 677、输出 38、总计 715 token。此证据验证了实际应用链路；模型目录估价不代表真实账单。

## 尚未执行的真实云端验收

已通过 Cloudflare 插件部署 Worker、启用 workers.dev 地址并核对 AI/DO/鉴权配置，详见 [DEPLOYMENT.md](DEPLOYMENT.md)。剩余真实请求验收仍需继续：开发环境网络策略拒绝访问已部署的 workers.dev 域名；搜索密钥名称已在 Worker 配置中确认，但未读取其值或验证有效性。DeepSeek BYOK 的真实应用 JSON ping 已通过；真实搜索仍未验收。

1. 已核对 AI binding、SQLite migrations、API_BEARER secret 和 100% 流量发布。API 鉴权和真实 JSON ping 已由调用方验证；接下来验证第三方 Worker Secrets 的有效性及实际网页读取。
2. 用真实模型执行多来源问题，确认搜索、读取多个来源、补搜/补读、引用准确性，以及最终正文没有中间说明。记录 prompt、run ID、模型、耗时、累计 usage 和各服务调用次数。
3. 真实 JSON/SSE、相同 session 的下一轮、首次响应丢失后的幂等重试、同会话并发、断线查询、显式取消；在真实模型调用和真实工具调用期间强制重启/驱逐 DO，验证恢复和已完成结果。
4. 用服务商测试配置或故障注入验证真实 401/403/429/空结果/超时和 provider 切换。mock 测试并不能证明真实密钥有效或服务不会改变合同。
5. 实测任意 HTTP/HTTPS 地址读取与跨站跳转、响应大小、内容类型；按用户最新指示，应用不再设置地址白名单或主机/IP 限制。
6. 核对五分钟截止和八轮耗尽、长期七天清理与 Pi alarm 协作；对照 Cloudflare 模型/DO 计算存储和搜索商账单验证成本。重放可能重复产生服务费用。

凭证应通过环境设置/Worker Secrets 配置，不通过聊天、源码或测试 fixture 提供真实值。部署命令和变量说明见 README；本验证记录没有把创建任务、编译或 dry-run 视为部署成功。

## 搜索回归修复

真实“杭州今天天气”请求出现搜索全部 provider_unavailable、读取全部 unsafe_url。已在 workerd 中用真实全局 fetch 与受控出站服务复现：请求函数被作为实例方法调用，导致调用接收者错误，出站处理器收到 0 次请求。改为无实例绑定的函数调用后，同一用例收到预期 4 次请求（2 次 Brave、2 次 Jina）。该回归测试与原有注入 HTTP mock 测试并存。

按用户后续指令，网页读取已取消所有域名/IP/端口白名单；支持任意 HTTP/HTTPS 地址以及跨站重定向，READ_HOSTS 已移除。测试覆盖从未列出的站点跳转至 HTTP、IP 和非默认端口，以及响应大小上限。还补充了安全诊断字段与 fallback 轨迹的测试，不输出真实密钥或上游响应正文。

本轮修复后的真实搜索与网页读取仍需调用方重发请求验收；开发环境的 workers.dev 出站限制仍然存在，不能把本地回归通过写成真实搜索已通过。
