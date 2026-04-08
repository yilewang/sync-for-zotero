# Sync for Zotero

一个 Chrome 扩展，作为 [LLM for Zotero](https://github.com/yat-lok/llm-for-zotero) 插件的 **网页聊天桥接工具**。它通过浏览器将 Zotero 连接到 ChatGPT：上传 PDF、发送提示词，并将 Markdown 格式的结果返回给 Zotero。

> **本扩展不是独立工具。** 需要配合 LLM for Zotero 插件（v3.7.17 或更高版本），并在插件设置中选择 **webchat 模式**。

## 工作原理

1. LLM for Zotero 启动本地中继服务器，并将 PDF + 提示词请求加入队列
2. 本扩展发现中继服务器并轮询待处理的查询
3. 当查询到达时，扩展将 PDF 上传到 ChatGPT，提交提示词，并等待响应
4. 响应以 Markdown 格式提取，并通过中继返回给 Zotero

## 前提条件

- 安装了 [Zotero](https://www.zotero.org/) 及 **[LLM for Zotero](https://github.com/yat-lok/llm-for-zotero) 插件 v3.7.17+**
- 在 LLM for Zotero 设置中，将模式设置为 **webchat**
- 一个 ChatGPT 账号（使用扩展时需要保持 chatgpt.com 标签页打开）

## 安装

### Chrome（加载为未打包的扩展）

1. 下载 `extension.zip` 或克隆此仓库
2. 将文件解压到本地
3. 打开 Chrome，访问 `chrome://extensions/`
4. 启用右上角的 **开发者模式**
5. 点击 **加载已解压的扩展程序**
6. 选择解压后的 `extension/` 文件夹
7. 工具栏中应出现 "Sync for Zotero" 图标

### 更新

当有新版本可用时，根据你的安装方式选择以下其中一种方法：

#### 方式 A：Git（如果你是通过克隆仓库安装的）

1. 打开终端，进入克隆的仓库文件夹
2. 运行 `git pull` 拉取最新更改
3. 在 Chrome 中打开 `chrome://extensions/`
4. 找到 "Sync for Zotero" 卡片，点击 **重新加载** (↻) 图标
5. 完成 — 扩展已更新

#### 方式 B：ZIP 下载（如果你是通过下载安装的）

1. 从 [Releases](https://github.com/yat-lok/sync-for-zotero/releases) 页面下载最新的 `extension.zip`
2. 解压文件，用新的 `extension/` 文件夹 **替换** 旧的文件夹
3. 在 Chrome 中打开 `chrome://extensions/`
4. 找到 "Sync for Zotero" 卡片，点击 **重新加载** (↻) 图标
5. 完成 — 扩展已更新

> **提示：** 不要在 Chrome 中删除旧的扩展再重新加载。只需替换文件并点击重新加载，即可保留你的扩展设置。

## 使用方法

1. 确保 Zotero 正在运行，且 LLM for Zotero 已激活（webchat 模式）
2. 在 Chrome 中打开 ChatGPT 标签页
3. 点击扩展图标，确认连接状态
4. 从 Zotero 发送查询 — 扩展会自动完成其余工作

## 许可证

详见 [LICENSE](LICENSE)。
