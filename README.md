# 宠物医院小红书 AI 工作台

这是一个宠物医院小红书图文笔记工作台。

当前完整工作流需要 Node 服务端代理：

- DeepSeek 生成结构化文案。
- image2.0 / GPT-Image-2 通过服务端 `/api` 代理提交出图任务，避免浏览器 CORS 和 API Key 暴露问题。
- GitHub Pages 只能托管静态页面，不能运行 `server.mjs`，因此不适合作为完整出图生产环境。

## 使用方式

1. 安装/使用 Node 20+。
2. 本地启动服务：`npm start` 或 `node server.mjs`
3. 打开 `http://127.0.0.1:4174/`
4. 新建或选择医院档案。
5. 在“接口”里填写 DeepSeek 和 image2.0 API Key。
6. 生成文案、确认文案，再生成知识卡片并导出发布包。

## 线上部署

不要用 GitHub Pages 作为正式出图地址。GitHub Pages 不能运行 Node API，image2.0 必然不可用。

推荐部署到 Render / Railway / Fly.io / VPS 这类能运行 Node Web 服务的平台。

### Render

1. 在 Render 新建 Blueprint 或 Web Service，连接本 GitHub 仓库。
2. Render 会读取 `render.yaml`，启动命令是 `npm start`。
3. 在 Environment 里配置：
   - `DEEPSEEK_API_KEY`
   - `IMAGE2_API_KEY`
   - 可选：`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`IMAGE2_BASE_URL`、`IMAGE2_MODEL`
4. 部署完成后，使用 Render 给出的 `.onrender.com` 地址打开工作台。

### Docker / VPS

```bash
docker build -t xhs-pet-ai-workbench .
docker run -p 4174:4174 \
  -e PORT=4174 \
  -e DEEPSEEK_API_KEY=你的DeepSeekKey \
  -e IMAGE2_API_KEY=你的ImageKey \
  xhs-pet-ai-workbench
```

代码可以推送到 GitHub 做版本管理；如果要完整上线，需要部署 Node 服务，保证以下接口可用：

- `/api/health`
- `/api/ai-config`
- `/api/xhs-notes/generate`
- `/api/visual-style/generate`
- `/api/visual-style/tasks/:taskId`
- `/api/image-proxy`

## 注意

GitHub Pages 是静态托管，不能运行图片代理接口。若只用 GitHub Pages，文案/出图相关接口会受限。
