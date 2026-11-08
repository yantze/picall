# 本地版验证记录

本记录针对 `main` 的 PiCall 0.7.0 本地运行版本。`Cloudflare` 分支及现有 Worker 的部署状态不受本次改动影响。

## 自动化测试

运行环境：Node.js 24.19.0，Linux；依赖通过 `npm ci` 安装，Pi coding agent / Pi AI 固定为 1.4.0。未新增 Cloudflare 运行时依赖，不需要构建或 Wrangler。

本地版初次交付的全量执行结果：`npm run check` 通过；`npm test` **152/152 通过**（约 23 秒，无跳过）；`npm pack --dry-run` 与 `git diff --check` 通过。测试使用 `test/isolate.mjs` 强制隔离临时 Pi profile，禁止读取开发者真实 `~/.pi` 配置；fixture 使用虚拟密钥。

覆盖内容：

- 配置：七项密钥只写入不完整回传、留空保留/显式清除、短密钥遮蔽、文件权限、原子更新和重载；模型 Base URL、模型容量、HTTP 工具合同校验。
- 研究工具：搜索顺序、临时服务失败回退、认证失败不回退、正常空结果、显式 Exa、Jina/TinyFish/HTTP 读取顺序、取消和总截止、2 MiB 大小和重定向限制、所有 HTTP/HTTPS 主机可请求。
- 性能行为：默认 3 条、600 字符摘要、6000 字符正文预览、分页/字面子串查找、导航跳过和原始偏移、验证码/错误页拒绝、本轮缓存、相同请求合并及取消隔离。
- 真实 Pi 子进程 + 模拟 OpenAI/搜索/HTTP 上游：网页配置驱动 provider 注册，关闭外部扩展仍有内置研究工具；搜索后读取并生成最终答案；跨 prompt 缓存隔离、密钥/模型变更使旧会话失效、硬工具回合上限。
- HTTP：JSON/SSE 仅输出确认完成的最终答案及累计 usage、默认/短名模型、会话历史、并发冲突、Bearer/CORS、失败与取消、202 持久受理、结果查询和断线继续。
- 幂等：未收到 session ID 的重试仍复用原任务；相同 key 不同内容冲突；默认模型变更或凭证清除不影响已受理任务查询和幂等重试。
- 持久化：完成结果跨重启可查询，未完成任务重启后标记 `process_interrupted`，取消后迟到结果不能覆盖状态，7 天记录清理。
- 写盘故障：受理、开始运行、保存完成结果、取消、关闭时存储不可用明确报 `storage_error` / 507；内存状态终结并唤醒等待者，不会将未保存答案返回成功或留下永久等待，晚到结果不能覆写失败。
- 原有 CLI、项目信任、工具开关、扩展、Skills、原生会话保存和附加系统提示词回归。

## 浏览器验收

使用本环境安装的真实 Chromium（Playwright 驱动）完成两组检查：

1. 配置界面配合模拟管理 API：11 项检查通过，包括设置 tab 深链接、默认模型排序、密钥配置状态、留空保留、显式清除/替换、保存后清空上游密钥输入、错误 JSON 定位、显式取消任务、390px 手机视口无横向溢出、无未捕获 JS 异常。
2. 实际 `bin/picall.js` 服务 + 真实 Pi + 本地模拟模型：通过浏览器保存模型地址与 key，核对配置落盘/GET 脱敏，刷新页面保持配置，发现 `picall/browser-model`，网页发送 SSE 请求返回最终答案，核对仅一次模型请求、run 查询为 completed、usage 22 tokens、无浏览器异常。退出后关闭服务和临时目录。

截图仅展示测试配置与虚拟密钥状态，没有读取或迁移真实用户凭证。

## 从其他网页打开管理页的修复

之前将 `Sec-Fetch-Site: cross-site` 一律拒绝，导致从聊天等网页点击本地地址进入首页也返回 403。现在只允许 GET 首页的顶层 document navigation 打开 HTML 页面；跨来源配置/密钥接口、iframe、跨来源 fetch、修改请求以及不可信 Host 仍拒绝。

本次验证：服务端测试 **49/49 通过**，包含新导航回归及既有鉴权/配置/任务接口测试；语法与 diff 检查通过。真实 Chromium 从 `localhost` 测试网页点击链接进入 `127.0.0.1` 的实际 CLI 管理页面，确认浏览器实际发送 cross-site / navigate / document 并成功打开；随后保存配置、刷新、真实 Pi 配合模拟模型完成 SSE 和结果查询，全部通过。

## 尚未进行的真实联调

本地版尚未使用真实 DeepSeek、Cloudflare AI Gateway 或 Brave/Tavily/TinyFish/Exa/Jina 凭证完成外部请求。此前 Worker 上的真实请求只证明云端版本的可达性和表现，不能作为本地版外部联调的替代。

在自己的本机填入正确的 Base URL 和对应密钥后，应验收一次 ping，以及一次“搜索 → 阅读 → 带来源回答”的真实请求，并记录 curl 的 `time_total`。模型网关需支持 OpenAI chat completions、上游流式响应和工具调用。不同网关的路由与鉴权合同需以其提供的兼容接口为准。

未验证 macOS/Windows 实机行为；这些平台没有 Linux 的相同文件权限语义。没有声称本地执行具有 Durable Objects / PiHarness 的断电或崩溃续跑能力。
