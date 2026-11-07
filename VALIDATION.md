# 验证记录（2026-11-08）

## 已完成的自动验证

在 Cloudflare 分支的独立仓库根目录执行，使用全新安装的锁定依赖；不依赖原仓库的本地执行包。无本地项目迁移、无真实服务凭证。

| 检查 | 结果 |
| --- | --- |
| npm run check | TypeScript 通过 |
| npm test | 20/20 通过（含 3 个 workerd 集成场景） |
| npm run build | Wrangler 生产入口 dry-run 成功；约 2.50 MiB / gzip 500 KiB；未上传部署 |
| git diff --check | 通过 |

分支以单个根提交发布，仅包含 Cloudflare 源码、测试、锁文件、CI、部署文档与 MIT 许可证，不继承旧提交历史。

固定依赖：agents 0.33.0，pi-ai/pi-durable/pi-schema/chord 1.5.0（lockfile）；Wrangler 4.158.0，匹配 Miniflare 5.20261104.0-beta / Workers types 5.20261107.1。研究版本与当前注册表的工具链有差异：原尝试的 Wrangler 4.76.0 本地 workerd 无法向 Lifecycle 提供 DO name，因此更新为实际可用且匹配的工具链。Pi 执行层 API 与交接方案一致。

20 项自动测试覆盖：

- 文本规范化、客户端 tools 拒绝、历史一致性、请求体大小限制；跨模型/轮次用量差值和缓存 token。
- Brave → Tavily → TinyFish 的 429/503 切换，401/403/400 不切换，凭证缺失、合法空结果、显式 Exa、用户取消与任务截止。
- TinyFish 搜索 query/page 与抓取 urls/format/per_url_timeout_ms 合同；时间/域名过滤、排除域名及结果后置过滤。
- Jina → TinyFish 顺序及 HTTP fallback 跳转限制、非法地址、类型与大小限制；持久正文查找；并行工具的请求次数累加；自定义工具名称/目标安全配置拒绝。
- 本地 workerd 使用真实 PiHarness、Pi Durable、Lifecycle 和 SQLite：搜索 → 并行阅读两个来源 → 再搜索 → 最终答案；4 次模型响应共 60 token，brave=2、jina=2；中间助手文本不进入最终 JSON/SSE。
- 独立 Bearer 鉴权、models、202 提交、首次响应之外的幂等重试及不同内容冲突、同会话并发 409、续接与历史冲突、JSON/SSE usage、SSE 读到心跳后断线继续查询、显式取消、turn_limit 没有 completion。
- 使用同一 SQLite 目录销毁并重新创建本地 workerd：完成结果和幂等映射保留；模型/工具尚未完成时关闭运行时后可继续；已存截止时间失效则失败；清理后旧结果 404，原会话名可重新提交。清理由测试直接调用同一清理处理器验证，没有等待真实七天。

这些集成测试的模型是测试代码模拟的 Workers AI SSE 响应，所有搜索和正文 HTTP 都由测试替身返回；它们验证执行与协议合同，不代表真实模型的研究质量、真实网络可达性或第三方合同已在线验收。运行时恢复测试是本地 workerd teardown/reopen，不等同生产 DO 强杀/平台驱逐。测试配置与测试专用控制路由不进入生产入口。

## 尚未执行的真实云端验收

当前环境没有 Secrets 或 Cloudflare 部署身份；未部署 Worker，未调用真实 Workers AI、Brave、Tavily、TinyFish、Exa 或 Jina。

1. 在部署方提供 Cloudflare 账户权限和 Worker Secrets 后，配置可信 READ_HOSTS，部署到独立测试 Worker。检查 AI binding、SQLite migrations 和强制 API 鉴权。
2. 用真实模型执行多来源问题，确认搜索、读取多个来源、补搜/补读、引用准确性，以及最终正文没有中间说明。记录 prompt、run ID、模型、耗时、累计 usage 和各服务调用次数。
3. 真实 JSON/SSE、相同 session 的下一轮、首次响应丢失后的幂等重试、同会话并发、断线查询、显式取消；在真实模型调用和真实工具调用期间强制重启/驱逐 DO，验证恢复和已完成结果。
4. 用服务商测试配置或故障注入验证真实 401/403/429/空结果/超时和 provider 切换。mock 测试并不能证明真实密钥有效或服务不会改变合同。
5. 实测白名单目标与跳转、响应大小、内容类型和边界地址；在扩大可读取域名前解决 README 所列 DNS 与远端提取器跳转边界。任意公网网页读取尚未实现为经过审计的 SSRF 防护路径。
6. 核对五分钟截止和八轮耗尽、长期七天清理与 Pi alarm 协作；对照 Cloudflare 模型/DO 计算存储和搜索商账单验证成本。重放可能重复产生服务费用。

凭证应通过环境设置/Worker Secrets 配置，不通过聊天、源码或测试 fixture 提供真实值。部署命令和变量说明见 README；本验证记录没有把创建任务、编译或 dry-run 视为部署成功。
