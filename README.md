<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/c01eee79-9a30-4aa9-a12a-032e2b6ca4c5

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 以独立桌面程序运行（Electron）

不通过浏览器，以桌面窗口方式运行：

1. 确保已安装依赖：`npm install`（若 Electron 报错，先关闭所有 Node/终端窗口后重试）
2. 启动桌面版：`npm run electron:dev`
   - 会自动在后台启动服务并打开一个桌面窗口，界面与浏览器版一致

### 打包成安装包（.exe）

生成 Windows 安装程序，便于分发给他人安装：

1. 先构建前端与后端：`npm run build` 和 `npm run build:server`
2. 打包：`npm run electron:build`
3. 安装包输出在 `release/` 目录，如 `尚品易站云资产 Setup x.x.x.exe`
4. 安装后，数据与资源目录在用户数据目录（如 `%APPDATA%/尚品易站云资产`）
