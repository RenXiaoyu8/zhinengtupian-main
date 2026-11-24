@echo off
echo ========================================
echo Fix Notification Button Issue
echo ========================================
echo.

echo Step 1: Check current permissions
echo ----------------------------------------
node check-user-detailed.cjs "黄俊根" "任小雨"

echo.
echo.
echo Step 2: Fix notification permission
echo ----------------------------------------
node fix-notification-permission.cjs "黄俊根"

echo.
echo.
echo Step 3: Verify fix
echo ----------------------------------------
node check-user-detailed.cjs "黄俊根"

echo.
echo ========================================
echo Done!
echo ========================================
echo.
echo Next steps:
echo 1. User must completely exit the client
echo 2. Reopen the client
echo 3. Login again
echo 4. Check if notification button appears
echo.
pause
