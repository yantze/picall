# PiCall 0.8.0 本地 Durable 版验证

运行环境：Linux、Node.js 24.19.0；Pi Durable / Pi AI / Pi Schema / Chord 固定 1.5.0。未安装 Coding Agent、Cloudflare Agents 或 Wrangler。Cloudflare 分支和 Worker 不在本次部署范围。

## 自动化验证

测试直接运行真实 Harness、官方 Node SQLite 适配器和本机模拟 OpenAI / Brave / Jina 服务，保留已有 WebTools 合同回归。

最终验证：`npm ci`、`npm run check`、`npm ls --depth=0` 和 `git diff --check` 均通过；`npm test` **67/67 通过**，包含 12 项进程终止及恢复测试。`npm pack --dry-run` 检查了 18 个发布文件，无旧 Coding Agent 执行器或测试夹具。

已覆盖：

- 搜索→阅读→最终答案，JSON/SSE 不拼接中间文本，累计 token 用量与服务调用数正确。
- 在索引写入后、Durable 提交后、模型输出中、工具 HTTP 中、最终答案已提交后和索引最终化前 SIGKILL 子进程，再启动恢复；固定 run ID 和单一输入 submission 不重复，已完成搜索不再发起，仅未完成读取安全重放。
- 已完成结果不重新生成；完整会话历史跨重启续接，闲置句柄释放后重新打开。
- 超时、工具轮数及持久取消意图跨重启保持；过期或配置变化任务在恢复时不发送新模型请求。
- 只有 Durable 执行模型重试，最多额外 2 次；输出耗尽、空答案、模型失败、轮数耗尽均不成功。
- 模型 key 作为字面值，不插值；上游错误只保留固定状态类别，测试 key、上游任意错误正文不写入运行时数据库或运营日志。
- 幂等首响应丢失重试、无 session ID 重试、Durable 提交前不提前确认受理、槽位满时同会话仍返回 409、降低并发配置后按容量恢复、模型配置改变后的旧任务回放、Bearer/CORS、首页跨站导航和配置同源限制。
- 旧 JSON 只读迁移、旧未完成任务失败、旧会话不可续接、迁移中断后记录和版本标记一并回滚、重试不重复导入、TTL 清理、单写者锁、SIGKILL 后锁释放、写盘故障拒绝等待者且不返回未保存答案。
- 配置密钥保留/清除/脱敏、短 key 遮盖、原子保存、配置备份与旧原生字段移除。
- CLI 在隔离 Pi profile 放入测试插件仍不会加载，原生 CLI 参数返回迁移说明。

## 浏览器验证

使用真实 Chromium / Playwright 连接实际 Node 服务与真实 Pi Durable，上游使用本机模拟服务。验证模型配置保存和脱敏、研究 SSE 最终答案与累计 usage、显式停止、服务关闭后重新启动恢复、刷新页面后以原 run ID 查询、启用本地 API key 后引导填写鉴权，以及移除原生 Pi 界面和手机布局；无浏览器脚本异常。

## 边界与未完成的真实联调

尚未使用用户真实 DeepSeek / AI Gateway、Brave、Tavily、TinyFish、Exa、Jina 密钥发起外部请求；此前 Worker 的真实请求不作为本地 Durable 版本的验收。仍需在用户自己的模型和搜索配置下验收 ping 和带来源研究请求，并记录 curl time_total。

恢复需要服务进程再次启动。未完成外部请求可能重放和重复计费；崩溃前供应商未返回的 usage 不能推算。测试包含进程 SIGKILL，不等于实际断电或磁盘硬件故障验证。尚未做 macOS/Windows 实机验收，文件权限语义也不同。
