# PiCall

## 1. LLM + Search 接口服务

PiCall 把 **Pi Durable** 封装成一个 OpenAI 兼容的 LLM 接口服务，将模型、网页搜索和正文读取接在一起。通过一次接口请求，模型就能搜索资料、阅读网页，再返回带来源的最终答案。

## 2. 在 Raycast 中获取最新信息

把 PiCall 接入 Raycast 等支持 OpenAI 兼容接口的应用，就可以直接提问并获取实时信息。例如，同样问「介绍一下 yantze/picall 这个项目？」：

| | Gemini 3.8 Flash Lite | DeepSeek Flash + Search（PiCall） |
| --- | --- | --- |
| 效果演示 | <img width="1500" height="948" alt="image" src="https://github.com/user-attachments/assets/36af4a48-59dd-48ff-a56b-1dce4754a685" /> | <img width="1500" height="948" alt="image" src="https://github.com/user-attachments/assets/7cd9e254-da78-4250-ba7d-aea9de6e34a6" /> |
| 本次耗时 | 4 秒 | 约 6 秒 |
| 回答结果 | 未识别项目，给出名称相关的猜测 | 获取仓库资料，准确介绍项目功能与部署方式 |

这次对比中，PiCall 多花约 2 秒，就获取到了更准确、更新的项目信息。

<!-- 此处加入用户提供的两张 Raycast 原始截图：第一张为 Gemini，第二张为 PiCall。 -->

## 3. 本地启动

需要 **Node.js 22.19+**，推荐 Node.js 24。首次在仓库目录运行 `npm ci` 安装依赖，之后直接启动：

```bash
npm run start
```

打开 http://127.0.0.1:8787，在网页中配置模型网关与搜索服务的 API Key（Brave、Tavily、TinyFish 等），保存即可使用。默认模型为 `deepseek-flash`；在 Raycast 等客户端中，将 Base URL 填为 http://127.0.0.1:8787/v1。


## 4. 会话记录

在左侧菜单选择「会话历史」，按最近一次任务时间查看记录。任务结束后自动显示已完成、失败或已取消；只有未结束的任务显示执行中。点击会话后，记录直接显示在右侧面板。每行展示一条 item，可展开消息内容；右侧显示毫秒级记录时间和所属任务耗时。支持分页、执行时自动刷新、浏览器前进后退和刷新后恢复选中会话；旧会话链接也会进入此界面。历史仅供读取，不会启动模型请求，也不占执行并发槽位。已完成的会话可点击「继续此会话」，或在下一次 API 请求中传 `X-Session-Id: <原 ID>`，发送消息后再执行新任务。失败、取消或已关闭的历史保留可查，需要新建会话；执行配置变更后的续接仍按原规则校验。耗时包含任务内等待与重试，同一任务的多条记录不可累加，历史缺失时间显示为未知。

本地所有会话统一保存到数据目录的 `sessions.sqlite`，按会话隔离；全局索引 `index.sqlite` 和写入锁独立保存。更新后首次启动会自动迁移旧的逐会话 SQLite，原文件保留作备份，随会话的 7 天过期清理。升级前请停止旧进程并备份整个数据目录；回滚时恢复整份备份。Cloudflare 会话面板需要管理登录，数据继续保存于原有 Durable Object。

迁移与存储边界见 [架构说明](docs/ARCHITECTURE.md)，测试结果见 [验证记录](VALIDATION.md)。
