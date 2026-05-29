# 宠物医院小红书 AI 工作台

这是一个宠物医院小红书图文笔记工作台。

当前完整工作流需要 Node 服务端代理：

- DeepSeek 生成结构化文案。
- image2.0 / GPT-Image-2 通过服务端 `/api` 代理提交出图任务，避免浏览器 CORS 和 API Key 暴露问题。
- GitHub Pages 只能托管静态页面，不能运行 `server.mjs`，因此不适合作为完整出图生产环境。

## 使用方式

1. 本地启动服务：`node server.mjs`
2. 打开 `http://127.0.0.1:4174/`
3. 新建或选择医院档案。
4. 在“接口”里填写 DeepSeek 和 image2.0 API Key。
5. 生成文案、确认文案，再生成知识卡片并导出发布包。

## 部署说明

代码可以推送到 GitHub 做版本管理；如果要完整上线，需要部署 Node 服务，保证以下接口可用：

- `/api/health`
- `/api/ai-config`
- `/api/xhs-notes/generate`
- `/api/visual-style/generate`
- `/api/visual-style/tasks/:taskId`
- `/api/image-proxy`

## 注意

GitHub Pages 是静态托管，不能运行图片代理接口。若只用 GitHub Pages，文案/出图相关接口会受限。
