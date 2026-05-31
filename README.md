# 宠物医院小红书 AI 工作台

一个纯前端的小红书图文笔记生成工具，浏览器直连 DeepSeek（文案）和 image2.0（出图），适合部署到 GitHub Pages 或本地双击打开。

## 使用方式

直接打开 `index.html`，或部署到 GitHub Pages：

1. 进入 GitHub 仓库 → Settings → Pages
2. Source 选 `main` 分支根目录
3. 等几分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`

打开页面后：

1. 新建或进入医院档案（医院名、医生名、品牌色、Logo 等）。
2. 顶部「接口」面板填入两个 Key：
   - **DeepSeek API Key**：用于生成文案。在 https://platform.deepseek.com/ 申请。
   - **image2.0 / APIMart API Key**：用于生成图片。Base URL 默认 `https://api.apimart.ai/v1`，模型默认 `gpt-image-2`。
3. 选主题、确认参数，点「生成文案」。
4. 点「image2.0 当前页」或「image2.0 全部页」出图。出图任务最长等约 5 分钟，浏览器会自动轮询；中途刷新或换医院再回来，会自动续上未完成任务。
5. 在导出区下载发布包。

## 数据存储

- 所有医院档案、文案、配置都存在你自己的浏览器 `localStorage`，不会上传到任何服务器。
- API Key 也只存在浏览器本地。**换电脑、清浏览器缓存会丢失**——重要的医院档案请用「导出数据」备份。
- Logo 上传后会自动压缩到 320×320 PNG/JPEG，避免占满 localStorage。

## 注意事项

- DeepSeek 和 image2.0 都是浏览器直连，所以 Key 不要分享给不信任的人——任何人在你的浏览器里都能看到。
- 出图依赖 image2.0 / APIMart 服务的 CORS 设置正常工作。如果遇到「浏览器无法直连」提示，可能是浏览器扩展拦截、企业网络或临时性的服务问题。
- 没有任何服务端，所以无需 Node、Docker、Render。
