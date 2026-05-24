# 宠物医院小红书 AI 工作台

这是一个纯前端本地/静态版工具，可以直接部署到 GitHub Pages。

## 使用方式

1. 打开页面后，新建或选择医院档案。
2. 在“接口”里填写自己的文本模型和图片模型 API Key。
3. API Key 只保存在当前浏览器的 localStorage，不会跟随仓库或页面文件一起发布。
4. 生成图文、预览卡片，并导出 PNG、JSON 或发布包。

## 部署到 GitHub Pages

把本仓库推送到 GitHub 后，在仓库设置里开启 Pages：

- Source: Deploy from a branch
- Branch: main
- Folder: /root

开启后访问 GitHub Pages 地址即可使用。

## 注意

这是纯 HTML 静态页面。第三方 API 是否能在浏览器里直接调用，取决于 API 服务是否允许跨域请求。
