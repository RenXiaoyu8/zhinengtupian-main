用法（公司主机 / 服务器电脑）

目标：电脑一开机，服务端自动启动，其他客户端可访问：
  http://<公司主机IP>:43123

前置条件：
1) 已在本机打包/构建过 dist（项目根目录存在 dist/index.html）
   - 运行：npm run build
   - 运行：npm run build:server （生成 electron/server-bundle.cjs）
2) 公司主机 Windows 防火墙已放行 43123 端口（可用 放行43123端口-公司主机.bat）
3) 本机已安装 Node.js（用于运行 electron/server-bundle.cjs）

安装开机自启：
1) 右键运行 server_autostart\install-autostart-task.bat → 以管理员身份运行
2) 可立即测试：在管理员 CMD 中执行
     schtasks /Run /TN "ShangpinCloudAssets-Server"
3) 查看日志：项目根目录 logs\server-autostart.log

卸载开机自启：
1) 右键运行 server_autostart\uninstall-autostart-task.bat → 以管理员身份运行

可改配置：
- server_autostart\run-server.cmd
  PORT=43123
  ASSETS_ROOT=D:\尚品易站图片
  DATABASE_PATH=项目根目录\visualflow.db
