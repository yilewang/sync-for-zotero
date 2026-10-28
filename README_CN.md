# Sync for Zotero

一个 Chromium 扩展，作为 [LLM for Zotero](https://github.com/yilewang/llm-for-zotero) 插件的 **网页聊天桥接工具**。它通过浏览器将 Zotero 连接到 ChatGPT、DeepSeek 或 Google Gemini：上传 PDF 和图片、发送提示词、同步聊天操作，并将 Markdown 格式的结果返回给 Zotero。

> **本扩展不是独立工具。** 需要配合 LLM for Zotero 插件（v3.7.17 或更高版本），并在插件设置中选择 **webchat 模式**。

## 工作原理

1. LLM for Zotero 启动本地中继服务器，并将 PDF + 提示词请求加入队列
2. 本扩展发现中继服务器并轮询待处理的查询
3. 当查询到达时，扩展会打开选定的网页聊天目标，上传附件，提交提示词，并等待响应
4. 响应以 Markdown 格式提取，并通过中继返回给 Zotero

## 前提条件

- 安装了 [Zotero](https://www.zotero.org/) 及 **[LLM for Zotero](https://github.com/yilewang/llm-for-zotero) 插件 v3.7.17+**
- 在 LLM for Zotero 设置中，将模式设置为 **webchat**
- 一个 ChatGPT、DeepSeek 或 Google Gemini 账号，取决于你在 LLM for Zotero 中选择的网页聊天目标

## 安装

### Chrome / Edge / Chromium（加载为未打包的扩展）

1. 下载 `extension.zip` 或克隆此仓库
2. 将文件解压到本地
3. 打开浏览器的扩展管理页面：
   - Chrome：`chrome://extensions/`
   - Microsoft Edge：`edge://extensions/`
4. 启用右上角的 **开发者模式**
5. 点击 **加载已解压的扩展程序**
6. 选择解压后的 `extension/` 文件夹
7. 工具栏中应出现 "Sync for Zotero" 图标

### 更新

当有新版本可用时，根据你的安装方式选择以下其中一种方法：

#### 方式 A：Git（如果你是通过克隆仓库安装的）

1. 打开终端，进入克隆的仓库文件夹
2. 运行 `git pull` 拉取最新更改
3. 打开浏览器的扩展管理页面（`chrome://extensions/` 或 `edge://extensions/`）
4. 找到 "Sync for Zotero" 卡片，点击 **重新加载** (↻) 图标
5. 完成 — 扩展已更新

#### 方式 B：ZIP 下载（如果你是通过下载安装的）

1. 从 [Releases](https://github.com/yilewang/sync-for-zotero/releases) 页面下载最新的 `extension.zip`
2. 解压文件，用新的 `extension/` 文件夹 **替换** 旧的文件夹
3. 打开浏览器的扩展管理页面（`chrome://extensions/` 或 `edge://extensions/`）
4. 找到 "Sync for Zotero" 卡片，点击 **重新加载** (↻) 图标
5. 完成 — 扩展已更新

> **提示：** 不要在浏览器中删除旧的扩展再重新加载。只需替换文件并点击重新加载，即可保留你的扩展设置。

## 使用方法

1. 确保 Zotero 正在运行，且 LLM for Zotero 已激活（webchat 模式）
2. 在浏览器中打开 ChatGPT、DeepSeek 或 Google Gemini 标签页
3. 点击扩展图标，确认连接状态
4. 从 Zotero 发送查询 — 扩展会自动完成其余工作

使用 Gemini 时，需要配套的 LLM for Zotero 版本提供 `gemini.google.com` WebChat 模型，并先在 `https://gemini.google.com/app` 登录。请自行在 Gemini 页面选择模型；扩展不会切换模型。Gemini 的回答从页面 DOM 提取，历史记录按请求读取，页面必须具备可用的输入框。

Gemini 每次请求支持一个 PDF，也可同时附加图片。扩展等待上传预览就绪，并验证已发送用户消息中的 PDF。输入框有残留附件时会阻止发送，请先移除附件。追问会确认已保存的会话地址；若发送结果无法确认，请先查看 Gemini 会话再重试，避免重复提问。Gemini DOM 结构变化可能需要更新适配器。

## 浏览器兼容性

本扩展面向支持 Manifest V3 的现代 Chromium 浏览器，包括 Google Chrome 和 Microsoft Edge。它使用 `chrome.storage.session`、扩展服务工作线程以及 `MAIN` world 内容脚本等 Chrome 扩展 API，因此不支持较旧的 Chromium 版本。

在 Windows 上，请确认 Windows Defender 防火墙或第三方安全软件允许 Zotero 接受来自浏览器的本机回环连接。扩展会在 `127.0.0.1` 或 `localhost` 的 `23119`-`23128` 端口发现 LLM for Zotero 的 webchat 中继。

## 许可证

详见 [LICENSE](LICENSE)。

## 保存带网页排版的 ChatGPT 对话

配合支持对话快照的 LLM for Zotero 版本，在 Zotero 的论文对话中点击
**导出 → 保存完整对话快照**，同时保持对应的 ChatGPT 对话网页打开。
插件会保存网页已加载的提问、回答、卡片、表格、SVG 路径和可读取的图片，
打包成单个离线 HTML，并自动作为论文附件导入。原有 Markdown 和笔记导出保持不变，
此功能新增 `https://images.openai.com/*` 访问权限，用于离线嵌入图片；
图片下载不携带 Cookie，也不跟随重定向。

这是静态快照，不是可继续聊天的网页。长对话请先滚动加载；侧边栏、账号界面、
脚本、外部字体和原始上传文件不在快照内，图表和引用会保存为静态内容。
图片无法保存时会中止保存并明确报错，避免生成缺图的存档。
第一版支持普通 `https://chatgpt.com/c/...` 对话，限制为 16 MiB、12,000 个 DOM 节点。
对话发生变化、仍在生成、超时或标签页不存在时会明确报错。每次保存新建附件，不覆盖原笔记。
