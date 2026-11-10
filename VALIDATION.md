# PiCall 0.9.0 双部署整合验证

运行环境：Linux、Node.js 24.19.0、真实 Pi Durable 1.5.0 和 SQLite；云端使用真实 workerd、PiHarness 和 Lifecycle，上游为模拟服务。

结果：共享工具 24 项、本地 44 项、workerd 24 项，共 **92 项自动测试通过**。锁文件重新安装、语法与类型检查、Worker dry-run 构建、独立 npm 安装包启动及双平台浏览器流程均通过。云端管理日志额外验证迟到的受理记录不会覆盖已完成状态。

## 自动验证

- `npm run check`：Node 语法、Wrangler 绑定类型一致性及 Worker TypeScript 检查。
- `npm test`：共享工具合同、本地测试、workerd 测试；两端使用同一份公开 API 合同。
- `npm run test:browser`：Chromium / Playwright 连接本地 Node 和模拟 Worker 的共用页面。
- `npm run test:package`：实际 npm pack，独立目录安装 tarball，只安装生产依赖并启动真实 SQLite，确认无 agents、Wrangler、Miniflare、Playwright。
- `npm run build:cloudflare`：Worker dry-run 构建及共享 Assets、既有绑定和追加迁移。

共享工具回归保留搜索顺序、失败分类、空结果、凭证错误、超时、分页、find、导航跳过、验证码、大小及重定向限制。协议验证模型短名、非法请求、最终答案 JSON/SSE、usage、幂等、任务状态及字段一致性。

本地保留索引落盘、Durable 提交、模型输出、工具 HTTP、最终答案提交和 API 最终化阶段 SIGKILL 恢复，以及取消意图、原期限、配置变化、执行容量、单写者锁、TTL、迁移事务和存储错误。

workerd 验证模型/工具执行中重建、自动 resume 前处理取消意图、已提交答案在过期后最终化、活跃会话旧结果清理、原生 AI Gateway 和管理工具。v1 格式夹具使用相同固定 SDK、原 root/前缀和 Run/History/RequestKey 记录写入真实 SQLite，再启动新版，验证旧答案、幂等、完整历史及旧在途不重放。

管理验证独立令牌、Cookie、同源限制、加密持久化、数据库无密钥原文、revision 冲突、清除后不回落环境值、重建时配置变化不发送新模型请求、错误主密钥不重置配置及管理令牌轮换。

浏览器验证本地研究及服务重启恢复、云端登录/退出、配置保存和脱敏、研究与停止、兼容网关及字面值 key、刷新后无凭证存储、手机布局和脚本异常。

## 未进行的真实联调

未部署线上 Worker，未修改其 Secrets、AI Gateway、域名或 Git 集成，也未发布 npm 包。未使用用户真实 DeepSeek、Brave、Tavily、TinyFish、Exa、Jina 凭证。历史 Worker 的真实天气结果不作为本轮验收，后续按 [部署说明](docs/DEPLOYMENT.md) 进行真实请求测试。

进程终止及 workerd 重建不等于物理断电验证；macOS/Windows 尚未实机验收。SQLite 不会自行启动本地服务，恢复可能重放未完成外部请求并重复计费，崩溃前未报告的 usage 无法补算。
