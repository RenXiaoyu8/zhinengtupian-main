# 尚品易站云资产 - 打包与部署说明

## 一、公司主机部署（服务端）

将程序运行在拥有固定公网 IP 的服务器上，提供 Web 界面与客户端 .exe 下载。

### 1. 环境与构建

- Node.js 18+
- 安装依赖: `npm ci` 或 `npm install`
- 构建前端: `npm run build`
- 构建服务端: `npm run build:server`（生成 `electron/server-bundle.cjs`）

### 2. 配置文件

在项目根目录放置或修改：

- **update_config.json**（版本与公网地址，供 `/check_update` 和下载链接使用）  
  可从 `update_config.example.json` 复制并修改：

```json
{
  "publicBaseUrl": "http://您的公网IP:43123",
  "version": "1.0.0",
  "fileName": "尚品易站云资产-1.0.0.exe",
  "releaseNotes": "可选：更新说明"
}
```

- 环境变量（可选）：
  - `PUBLIC_BASE_URL`：同 `publicBaseUrl`，优先于配置文件
  - `PORT`：监听端口，默认 43123
  - `ASSETS_ROOT`：资产根目录，如 `D:\尚品易站图片`

### 3. 发布目录

- 在项目根下创建 **releases** 目录，将打包好的 `尚品易站云资产-x.x.x.exe` 放入。
- 新版本发布时：更新 `update_config.json` 的 `version`、`fileName`（及可选 `releaseNotes`），并把新 exe 放入 `releases/`。

### 4. 仅运行服务端（不启动 Electron）

公司主机只跑 HTTP 服务时，可单独启动 Node：

```bash
set NODE_ENV=production
set STATIC_DIR=%cd%\dist
node electron/server-bundle.cjs
```

或使用项目中的 `启动服务端-公司主机.bat`（若已提供）。

服务将：

- 提供 SPA：`/` 及前端静态资源（来自 `dist`）
- 提供 API：`/api/*`
- 提供版本检查：`GET /check_update`
- 提供 exe 下载：`/releases/尚品易站云资产-x.x.x.exe`

---

## 二、客户端 Electron 打包（主程序 .exe）

### 1. 使用 electron-builder（当前项目已配置）

```bash
npm run build
npm run build:server
npx electron-builder
```

输出在 **release/** 目录，如：

- `release/尚品易站云资产 1.0.0.exe`（NSIS 安装包）
- 或未打包目录在 `release/ShangpinCloudAssets/` 中

### 2. 版本号

- 版本来自 **package.json** 的 `version`。
- 发布新版本时：先改 `package.json` 的 `version`，再执行上述构建，并把生成的 exe 放到公司主机的 `releases/` 并更新 `update_config.json`。

### 3. 图标与资源

- 在 **package.json** 的 `build` 中可配置 `win.icon` 指向 `.ico` 路径。
- 静态资源由 Vite 打包到 `dist/`，无需在 spec 中单独配置。

---

## 三、更新程序 updater.exe（PyInstaller）

### 1. 环境

- Python 3.7+
- 安装 PyInstaller: `pip install pyinstaller`

### 2. 打包

```bash
pyinstaller updater.spec
```

生成 **dist/updater.exe**。将该 exe 与主程序放在同一目录（或随安装包一起分发），主程序更新时会调用它。

### 3. 图标（可选）

若有 `build/updater.ico`，在 **updater.spec** 中设置：

```python
icon='build/updater.ico',
```

### 4. 单文件与路径

- 当前 spec 已生成单文件 exe，无需额外配置静态资源路径；updater.py 仅使用标准库，无数据文件依赖。

---

## 四、客户端双链路与更新流程

### 1. 双链路配置（server_config.json）

员工电脑上，将 **server_config.json** 放在以下任一位置（优先使用靠前的）：

- 与主程序 exe 同目录（打包后部署时推荐）
- 用户数据目录（如 `%APPDATA%/尚品易站云资产/`）

内容示例：

```json
{
  "lanBaseUrl": "http://192.168.x.x:43123",
  "publicBaseUrl": "http://公司公网IP:43123"
}
```

- 若存在该配置：启动时先请求 `lanBaseUrl/check_update`，失败再请求 `publicBaseUrl/check_update`，用第一个成功的地址打开界面（内网优先，带宽更好）。
- 若不存在：按原逻辑本地启动服务并打开 `http://localhost:43123`（单机模式）。

### 2. 更新流程

- 启动后约 2 秒，客户端会请求当前使用的服务器地址的 `/check_update`（远程模式用选中的 baseUrl，单机模式若配置了 `publicBaseUrl` 则用其检查）。
- 若服务器返回的版本号大于当前 exe 版本，则弹出“发现新版本”提示。
- 用户选择“立即更新”后，主程序退出并启动 **updater.exe**，传入当前 exe 路径和下载链接；updater 下载新 exe、替换旧 exe，并可选择重新启动主程序。

---

## 五、权限与安全

- **账号与权限**：在 **users.json** 中为每个账号配置 `role` 和 `permissions`（如 `canUpload`、`canDelete` 等）。例如 `Role="Guest"` 的账号可将 `canUpload`、`canDelete` 等设为 `false`，服务端会据此限制对应接口。
- **Token**：除登录、`/check_update`、`/api/config` 等公开接口外，其余 API 均需在请求头携带合法 Token（`Authorization: Bearer <token>`），公网环境下务必使用 HTTPS 或至少保证 Token 不泄露。

---

## 六、简要检查清单

- [ ] 公司主机：已配置 `update_config.json`（含 `publicBaseUrl`、`version`、`fileName`）
- [ ] 公司主机：已创建 `releases/` 并放入当前版本 exe
- [ ] 公司主机：已设置 `ASSETS_ROOT`、`PORT` 等环境变量（如需要）
- [ ] 客户端：已放置 `server_config.json`（双链路）和 `updater.exe`（与主程序同目录）
- [ ] 新版本发布：更新 `package.json` 的 version → 构建主程序 → 更新 `update_config.json` 与 `releases/` 中的 exe
