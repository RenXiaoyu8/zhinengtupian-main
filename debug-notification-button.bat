@echo off
chcp 65001 >nul
echo ========================================
echo 通知按钮显示问题诊断脚本
echo ========================================
echo.

node check-user-detailed.cjs "黄俊根" "任小雨"

echo.
echo ========================================
echo 诊断完成
echo ========================================
echo.
echo 如果两个用户的 canSendNotification 都是 true，
echo 但通知按钮只对一个用户显示，可能的原因：
echo.
echo 1. 客户端缓存问题 - 需要完全退出并重新登录
echo 2. buildPermissions 函数覆盖了权限
echo 3. 用户角色导致权限被重置
echo.
pause
