const path = require('path');
const fs = require('fs');
const os = require('os');
const { fileURLToPath } = require('url');
const zlib = require('zlib');

/** 启动日志：写入 %LOCALAPPDATA%\shangpin-cloud-assets\startup.log，与诊断 bat 一致 */
const STARTUP_LOG = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'shangpin-cloud-assets', 'startup.log');
function startupLog(msg) {
  try {
    const dir = path.dirname(STARTUP_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(STARTUP_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

startupLog('1. main.cjs 开始加载');

let app, BrowserWindow, Menu, ipcMain, shell, dialog, Tray, nativeImage;
try {
  const electron = require('electron');
  app = electron.app;
  BrowserWindow = electron.BrowserWindow;
  Menu = electron.Menu;
  ipcMain = electron.ipcMain;
  shell = electron.shell;
  dialog = electron.dialog;
  Tray = electron.Tray;
  nativeImage = electron.nativeImage;
} catch (e) {
  startupLog('2. electron 加载失败: ' + String(e && e.message ? e.message : e));
  process.exit(1);
}
const { spawn } = require('child_process');
const net = require('net');

startupLog('2. electron 模块加载完成');

const PORT = 43123;
const isDev = !app.isPackaged;
const CHECK_UPDATE_TIMEOUT_MS = 8000;
const LOCALHOST_TIMEOUT_MS = 1500;
const isServerOnly = process.argv.includes('--server-only');

if (!isServerOnly) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    startupLog('another instance is already running, exiting.');
    app.quit();
  } else {
    app.on('second-instance', () => {
      startupLog('second-instance detected, focusing existing window.');
      showMainWindow();
    });
  }
}

// #region agent log
const DEBUG_LOG_PATH = path.join(__dirname, '..', 'debug-18dc8e.log');
function dbg(msg, data) {
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, JSON.stringify({ sessionId: '18dc8e', location: 'electron/main.cjs', message: msg, data: data || {}, timestamp: Date.now() }) + '\n');
  } catch (_) {}
}
// #endregion

/** 读取客户端双链路配置（局域网优先、公网备用） */
function loadServerConfig() {
  const configPaths = [
    path.join(path.dirname(process.execPath), 'server_config.json'),
    path.join(app.getPath('userData'), 'server_config.json'),
  ];
  if (isDev) configPaths.unshift(path.join(__dirname, '..', 'server_config.json'));
  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        const raw = fs.readFileSync(p, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg.lanBaseUrl || cfg.publicBaseUrl) return cfg;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/** 静默请求 check_update，返回 { ok, version, downloadUrl } 或 { ok: false, reason } */
function fetchCheckUpdate(baseUrl, timeoutMs = CHECK_UPDATE_TIMEOUT_MS) {
  const url = baseUrl.replace(/\/$/, '') + '/check_update';
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
    const protocol = url.startsWith('https') ? require('https') : require('http');
    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      clearTimeout(timer);
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return fetchCheckUpdate(loc, timeoutMs).then(resolve);
      }
      if (res.statusCode !== 200) {
        resolve({ ok: false, reason: 'status ' + res.statusCode });
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ ok: true, version: j.version, downloadUrl: j.downloadUrl || '', releaseNotes: j.releaseNotes, fileName: j.fileName || '' });
        } catch (e) {
          resolve({ ok: false, reason: 'parse' });
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err && err.code ? err.code : 'error' });
    });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve({ ok: false, reason: 'timeout' }); });
  });
}

/** 比较版本号，返回 true 表示 serverVersion > localVersion */
function isNewerVersion(serverVersion, localVersion) {
  const toParts = (v) => (String(v || '0').match(/\d+/g) || ['0']).map(Number);
  const s = toParts(serverVersion);
  const l = toParts(localVersion);
  for (let i = 0; i < Math.max(s.length, l.length); i++) {
    const a = s[i] || 0;
    const b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

/** 双链路：开发环境只试本机（省时），生产环境先试局域网/公网再本机 */
async function resolveBaseUrl(config) {
  const lan = (config.lanBaseUrl || '').replace(/\/$/, '');
  const pub = (config.publicBaseUrl || '').replace(/\/$/, '');
  const local = 'http://127.0.0.1:43123';
  const urls = isDev
    ? [local]
    : [lan, pub, local].filter(Boolean);
  for (const u of urls) {
    const timeout = u === local ? LOCALHOST_TIMEOUT_MS : CHECK_UPDATE_TIMEOUT_MS;
    const r = await fetchCheckUpdate(u, timeout);
    if (r.ok) return u;
    startupLog('try ' + u + ' fail: ' + (r.reason || 'unknown'));
  }
  return null;
}

/**
 * 升级提示 skip-cache：同一版本 4 小时内不重复弹窗。
 * 防止升级失败后每次启动都弹出提示的"升级循环"问题。
 */
const UPDATE_SKIP_PATH = path.join(app.getPath('userData'), 'update-skip.json');
const SKIP_TTL_MS = 4 * 60 * 60 * 1000; // 4 小时

function readUpdateSkip() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_SKIP_PATH, 'utf8'));
  } catch (_) { return null; }
}

function writeUpdateSkip(version) {
  try {
    fs.writeFileSync(UPDATE_SKIP_PATH, JSON.stringify({ version, at: Date.now() }), 'utf8');
  } catch (_) {}
}

function shouldSkipUpdate(version) {
  const cache = readUpdateSkip();
  if (!cache || cache.version !== version) return false;
  return (Date.now() - (cache.at || 0)) < SKIP_TTL_MS;
}

/** 启动更新程序并退出当前应用 */
function runUpdaterAndQuit(currentExePath, downloadUrl) {
  const dir = path.dirname(currentExePath);
  const updaterPath = path.join(dir, 'updater.exe');
  if (!downloadUrl) {
    dialog.showMessageBoxSync({ type: 'warning', title: '更新', message: '未找到可下载的新版本安装包，请先在服务器发布新版本。' });
    return;
  }
  if (!fs.existsSync(updaterPath)) {
    dialog.showMessageBoxSync({ type: 'warning', title: '更新', message: '未找到 updater.exe，当前客户端无法自动更新。请重新分发带更新器的新客户端。' });
    return;
  }
  try {
    // 从临时目录启动 updater，避免 updater.exe 自己锁住自己。
    // 这样后续 zip 覆盖时也能一并更新安装目录中的 updater.exe。
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shangpin-updater-'));
    const tempUpdaterPath = path.join(tempDir, 'updater.exe');
    fs.copyFileSync(updaterPath, tempUpdaterPath);

    // 通过 cmd /c start 让 updater.exe 在独立控制台窗口中运行。
    // 直接 spawn + stdio:'ignore' 会把 stdout/stderr 重定向到 NUL 设备，
    // 导致控制台窗口弹出后完全空白（进度/错误均不可见）。
    // 用 start "" 启动时，updater.exe 获得新控制台的 CONOUT$ 句柄，print() 输出正常可见。
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    const cmdArg = `/c start "" ${q(tempUpdaterPath)} --current-exe ${q(currentExePath)} --url ${q(downloadUrl)} --restart`;
    spawn('cmd.exe', [cmdArg], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      cwd: tempDir,
    });
    allowQuit = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.destroy(); } catch (_) {}
    }
    if (serverProcess) {
      try { serverProcess.kill(); } catch (_) {}
      serverProcess = null;
    }
    app.quit();
  } catch (e) {
    dialog.showMessageBoxSync({ type: 'error', title: '更新失败', message: '启动更新程序失败', detail: String(e && e.message ? e.message : e) });
  }
}

/** 等待端口文件出现并读取端口号 */
function waitForPortFile(portFilePath, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const fs = require('fs');
    const check = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('等待服务启动超时'));
        return;
      }
      try {
        if (fs.existsSync(portFilePath)) {
          const port = parseInt(fs.readFileSync(portFilePath, 'utf8'), 10);
          if (!isNaN(port)) {
            resolve(port);
            return;
          }
        }
      } catch (e) { /* ignore */ }
      setTimeout(check, 200);
    };
    check();
  });
}

/** 等待端口可连接 */
function waitForPort(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('等待服务启动超时'));
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });
      socket.on('timeout', () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });
      socket.connect(port, '127.0.0.1');
    };
    tryConnect();
  });
}

let serverProcess = null;
let mainWindow = null;
let downloadSerial = 1;
const pendingDownloadRequests = [];

function sendDownloadProgress(targetWindow, payload) {
  try {
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('download-progress', payload);
    }
  } catch (_) {}
}
let tray = null;
let trayBlinkTimer = null;
let trayBlinkOn = false;
let allowQuit = false;
let cachedNormalTrayIcon = null;
let cachedAlertTrayIcon = null;
let cachedHiddenTrayIcon = null;
const APP_LOGO_FILES = ['尚品易站云资产logo-01.svg', 'app-icon.png', '尚品易站云资产logo.png'];

const CLOSE_PREF_PATH = path.join(app.getPath('userData'), 'close-preference.json');

function readClosePreference() {
  try {
    const value = JSON.parse(fs.readFileSync(CLOSE_PREF_PATH, 'utf8'));
    return value && (value.action === 'minimize' || value.action === 'quit') ? value.action : null;
  } catch (_) {
    return null;
  }
}

function writeClosePreference(action) {
  try {
    fs.writeFileSync(CLOSE_PREF_PATH, JSON.stringify({ action }), 'utf8');
  } catch (_) {}
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function fallbackTrayIcon() {
  const size = 32;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x += 1) {
      const isBar = (y >= 10 && y <= 13 && x >= 8 && x <= 23) || (y >= 18 && y <= 21 && x >= 8 && x <= 23);
      const color = isBar ? [255, 255, 255, 255] : [14, 165, 233, 255];
      raw[offset++] = color[0];
      raw[offset++] = color[1];
      raw[offset++] = color[2];
      raw[offset++] = color[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png).resize({ width: 16, height: 16 });
}

function hiddenTrayIcon() {
  if (cachedHiddenTrayIcon && !cachedHiddenTrayIcon.isEmpty()) return cachedHiddenTrayIcon;
  const size = 16;
  const image = nativeImage.createEmpty();
  cachedHiddenTrayIcon = image.resize({ width: size, height: size });
  return cachedHiddenTrayIcon;
}

function appTrayIcon() {
  if (cachedNormalTrayIcon && !cachedNormalTrayIcon.isEmpty()) return cachedNormalTrayIcon;
  const baseDirs = [
    path.join(__dirname, '..'),
    process.resourcesPath || '',
    path.join(process.resourcesPath || '', 'app.asar.unpacked'),
    path.dirname(process.execPath),
  ];
  const candidates = baseDirs.flatMap((dir) => APP_LOGO_FILES.map((file) => path.join(dir, file)));
  for (const logoPath of candidates) {
    try {
      if (!logoPath || !fs.existsSync(logoPath)) continue;
      const image = nativeImage.createFromPath(logoPath);
      if (image && !image.isEmpty()) {
        cachedNormalTrayIcon = image.resize({ width: 18, height: 18 });
        return cachedNormalTrayIcon;
      }
    } catch (_) {}
  }
  cachedNormalTrayIcon = fallbackTrayIcon();
  return cachedNormalTrayIcon;
}

function alertOverlayIcon() {
  cachedAlertTrayIcon = hiddenTrayIcon();
  return cachedAlertTrayIcon;
}

const normalTrayIcon = () => appTrayIcon();
const alertTrayIcon = () => alertOverlayIcon();

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return tray;
  try {
    tray = new Tray(normalTrayIcon());
  } catch (e) {
    startupLog('create tray failed: ' + String(e && e.message ? e.message : e));
    return null;
  }
  tray.setToolTip('尚品易站云资产');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出软件', click: () => { allowQuit = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  return tray;
}

function setTrayAlert(active, count) {
  if (!ensureTray()) return;
  if (!active) {
    if (trayBlinkTimer) clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
    trayBlinkOn = false;
    tray.setImage(normalTrayIcon());
    tray.setToolTip('尚品易站云资产');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
    return;
  }
  tray.setToolTip(`尚品易站云资产 - ${count || 1} 条通知`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
  if (!trayBlinkTimer) {
    trayBlinkTimer = setInterval(() => {
      trayBlinkOn = !trayBlinkOn;
      tray.setImage(trayBlinkOn ? alertTrayIcon() : normalTrayIcon());
    }, 500);
  }
}

const ASSETS_ROOT = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';

/**
 * @param {number|string} portOrBaseUrl - 本地端口（独立模式）或完整 baseUrl（远程模式，如 http://192.168.1.100:43123）
 * @param {boolean} isRemote - 是否远程模式（不启本地服务，直接加载公司主机地址）
 */
function createWindow(portOrBaseUrl, isRemote = false) {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '尚品易站云资产',
    icon: appTrayIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  ensureTray();

  const loadUrl = isRemote ? String(portOrBaseUrl) : `http://localhost:${portOrBaseUrl}`;
  win.loadURL(loadUrl);

  // 禁止拖入文件时跳转；若为 file:// 则视为从系统拖入的文件，将路径发给渲染进程以打开智能上传
  win.webContents.on('will-navigate', (event, url) => {
    // #region agent log
    dbg('webContents will-navigate', { url: String(url || '') });
    // #endregion
    if (!url) return;
    if (url.startsWith('content://')) {
      event.preventDefault();
      return;
    }
    if (url.startsWith('file://')) {
      event.preventDefault();
      try {
        const pathStr = fileURLToPath(url);
        const exists = pathStr ? fs.existsSync(pathStr) : false;
        dbg('will-navigate file://', { url: url.slice(0, 80), pathStr: pathStr ? pathStr.slice(0, 80) : '', exists });
        if (pathStr && exists) {
          win.webContents.send('os-files-dropped', [pathStr]);
        }
      } catch (e) {
        dbg('will-navigate file:// error', { err: (e && e.message) || String(e) });
      }
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.on('will-download', (_event, item, webContents) => {
    const url = item.getURL();
    const owner = webContents ? BrowserWindow.fromWebContents(webContents) : win;
    const ownerId = owner && !owner.isDestroyed() ? owner.id : 0;
    const matchIndex = pendingDownloadRequests.findIndex((entry) =>
      entry.url === url && (!webContents || entry.webContentsId === webContents.id || entry.windowId === ownerId)
    );
    const request = matchIndex >= 0
      ? pendingDownloadRequests.splice(matchIndex, 1)[0]
      : { id: downloadSerial++, url, webContentsId: webContents ? webContents.id : 0, windowId: ownerId, createdAt: Date.now() };
    const payloadBase = {
      id: request.id,
      url,
      filename: item.getFilename(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
    };
    sendDownloadProgress(owner, { ...payloadBase, state: 'started' });
    item.on('updated', (_evt, state) => {
      sendDownloadProgress(owner, {
        ...payloadBase,
        state: state === 'interrupted' ? 'interrupted' : 'progress',
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
      });
    });
    item.once('done', (_evt, state) => {
      sendDownloadProgress(owner, {
        ...payloadBase,
        state: state === 'completed' ? 'completed' : 'failed',
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
      });
    });
  });

  // #region agent log
  win.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    dbg('webContents did-start-navigation', { url: String(url || ''), isInPlace: !!isInPlace, isMainFrame: !!isMainFrame });
  });
  win.webContents.on('will-redirect', (_e, url) => {
    dbg('webContents will-redirect', { url: String(url || '') });
  });
  win.webContents.on('did-navigate', (_e, url) => {
    dbg('webContents did-navigate', { url: String(url || '') });
  });
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    dbg('webContents did-navigate-in-page', { url: String(url || '') });
  });
  // #endregion

  // 页面加载完成后注入拖放监听，确保从系统拖入文件能触发智能分类上传（不依赖 index.html 是否含内联脚本）
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (function(){
        var isNewDevUpload = function(e){ try { return e && e.target && e.target.closest && e.target.closest('[data-newdev-upload]'); } catch(err) { return false; } };
        var p = function(e){ e.preventDefault(); e.stopPropagation(); if(e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
        document.addEventListener('dragover', function(e){
          if(isNewDevUpload(e)){
            e.preventDefault();
            if(e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            return;
          }
          p(e); try{ window.dispatchEvent(new CustomEvent('app-dragover')); }catch(err){}
        }, true);
        document.addEventListener('drop', function(e){
          if(isNewDevUpload(e)){
            e.preventDefault();
            if(e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            return;
          }
          p(e);
          try{ window.dispatchEvent(new CustomEvent('app-dragleave')); }catch(err){}
          if (window.__onFilesDropped && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            try{ window.__onFilesDropped(Array.from(e.dataTransfer.files)); }catch(err){}
          }
        }, true);
        document.addEventListener('dragleave', function(e){
          if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) { try{ window.dispatchEvent(new CustomEvent('app-dragleave')); }catch(err){} }
        }, true);
      })();
    `).catch(() => {});
  });

  if (isRemote) {
    win.webContents.on('did-fail-load', (_, code, desc) => {
      if (code !== -3) {
        dialog.showMessageBox(win, {
          type: 'error',
          title: '加载失败',
          message: '无法加载页面',
          detail: desc || `错误码: ${code}\n请检查公司服务器是否已启动。`,
        });
      }
    });
  }
  win.on('close', async (event) => {
    if (allowQuit) return;
    const saved = readClosePreference();
    if (saved === 'minimize') {
      event.preventDefault();
      win.hide();
      return;
    }
    if (saved === 'quit') {
      allowQuit = true;
      return;
    }

    event.preventDefault();
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭软件',
      message: '点击关闭按钮时，你希望怎么处理？',
      detail: '选择“最小化到右下角”后，软件会留在系统托盘，收到通知会闪动提醒。',
      buttons: ['最小化到右下角', '关闭软件', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择，下次直接执行',
      checkboxChecked: false,
    });
    if (result.response === 2) return;
    const action = result.response === 0 ? 'minimize' : 'quit';
    if (result.checkboxChecked) writeClosePreference(action);
    if (action === 'minimize') {
      win.hide();
    } else {
      allowQuit = true;
      app.quit();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });
}

async function startServerDev() {
  const projectRoot = path.join(__dirname, '..');
  // Prefer starting bundled server inside Electron process.
  // This avoids using system Node (e.g. v24) which can fail to load native deps like better-sqlite3.
  const distDir = path.join(projectRoot, 'dist');
  const bundlePath = path.join(__dirname, 'server-bundle.cjs');
  if (fs.existsSync(bundlePath)) {
    process.env.NODE_ENV = 'production';
    process.env.ASSETS_ROOT = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';
    process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(app.getPath('userData'), 'visualflow.dev.db');
    process.env.STATIC_DIR = distDir;
    process.env.DISABLE_HMR = 'true';
    const { startServer } = require('./server-bundle.cjs');
    const port = await startServer();
    await waitForPort(port);
    return port;
  }

  // Fallback (rare): spawn tsx server.ts if bundle missing.
  const portFilePath = path.join(projectRoot, '.server-port');
  try { require('fs').unlinkSync(portFilePath); } catch (e) {}
  const isWin = process.platform === 'win32';
  const opts = {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      STATIC_DIR: distDir,
      DISABLE_HMR: 'true',
      PORT_FILE: portFilePath,
    },
    stdio: 'inherit',
  };
  if (isWin) {
    opts.shell = true;
    serverProcess = spawn('npx tsx server.ts', [], opts);
  } else {
    serverProcess = spawn('npx', ['tsx', 'server.ts'], opts);
  }
  serverProcess.on('error', (err) => startupLog('startServerDev spawn error: ' + String(err && err.message)));
  const port = await waitForPortFile(portFilePath);
  await waitForPort(port);
  return port;
}

async function startServerProd() {
  const appPath = app.getAppPath();
  const exeDir = path.dirname(process.execPath);
  const assetsRoot = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';

  process.env.NODE_ENV = 'production';
  process.env.ASSETS_ROOT = assetsRoot;
  process.env.DATABASE_PATH = path.join(assetsRoot, '程序图片勿动', 'visualflow.db');
  process.env.STATIC_DIR = path.join(appPath, 'dist');
  process.chdir(exeDir);

  const { startServer } = require('./server-bundle.cjs');
  const port = await startServer();
  return port;
}

// 调试日志：渲染进程/内联脚本通过 IPC 写入，便于无 ingest 服务时排查拖放等问题
ipcMain.handle('debug-log', (_, payload) => {
  try {
    const line = typeof payload === 'object' ? JSON.stringify({ ...payload, timestamp: payload.timestamp || Date.now() }) + '\n' : payload + '\n';
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch (e) { /* ignore */ }
});

ipcMain.on('download-url', (event, url) => {
  try {
    if (!url || typeof url !== 'string') return;
    const sender = event && event.sender;
    const win = sender && typeof sender.getOwnerBrowserWindow === 'function'
      ? sender.getOwnerBrowserWindow()
      : BrowserWindow.fromWebContents(sender);
    pendingDownloadRequests.push({
      id: downloadSerial++,
      url,
      webContentsId: sender && sender.id ? sender.id : 0,
      windowId: win && !win.isDestroyed() ? win.id : 0,
      createdAt: Date.now(),
    });
    if (sender && typeof sender.downloadURL === 'function') {
      sender.downloadURL(url);
    }
  } catch (e) { /* ignore */ }
});

ipcMain.on('notification-state', (_event, payload) => {
  const count = Number(payload && payload.count ? payload.count : 0);
  setTrayAlert(count > 0, count);
});

// 由渲染进程请求：给定一个目录或文件路径，递归返回其中所有文件的绝对路径
ipcMain.handle('get-files-from-dir', async (_, dirPath) => {
  try {
    if (!dirPath || typeof dirPath !== 'string') return [];
    const p = path.resolve(dirPath);
    if (!fs.existsSync(p)) return [];
    const result = [];
    function walk(cur) {
      const st = fs.statSync(cur);
      if (st.isDirectory()) {
        const entries = fs.readdirSync(cur);
        for (const name of entries) {
          walk(path.join(cur, name));
        }
      } else if (st.isFile()) {
        result.push(cur);
      }
    }
    walk(p);
    return result;
  } catch (e) {
    return [];
  }
});

// 由渲染进程请求：用本机路径上传到服务器（用于 will-navigate 拦截到的系统拖入文件）
// 后端 /api/upload 使用 upload.array('files') 和 req.body.path，字段名必须为 files 和 path
ipcMain.handle('upload-local-paths', async (event, opts) => {
  const { paths, targetPath, baseUrl, token, conflictStrategy } = opts || {};
  if (!paths || !Array.isArray(paths) || paths.length === 0 || !targetPath || !token) {
    return { ok: false, error: '参数缺失' };
  }
  const rawBase = (baseUrl && String(baseUrl).trim()) || '';
  if (!rawBase || rawBase === 'null' || rawBase.startsWith('file://')) {
    return { ok: false, error: '无效的服务器地址，请从正确地址打开应用（如 http://服务器IP:端口）' };
  }
  const uploadUrl = rawBase.replace(/\/$/, '') + '/api/upload';
  console.log('upload-local-paths: request URL', uploadUrl);
  const win = event && event.sender ? event.sender.getOwnerBrowserWindow() : null;

  function showErrorDialog(msg) {
    const text = String(msg || '未知错误');
    console.error('upload-local-paths:', text);
    if (dialog && dialog.showMessageBox) {
      dialog.showMessageBox(win || null, { type: 'error', title: '上传失败', message: text }).catch(() => {});
    }
  }

  // 递归收集目录下所有文件；用于从操作系统拖入整个文件夹
  // 目录时 base 用父目录，使 relName 包含顶层文件夹名（如「定/子文件夹/文件.png」）
  function collectFilesFromPath(p) {
    const result = [];
    if (!p || !fs.existsSync(p)) return result;
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      result.push({ full: p, relName: path.basename(p) });
      return result;
    }
    if (stat.isDirectory()) {
      const base = path.dirname(p);
      const stack = [p];
      while (stack.length) {
        const cur = stack.pop();
        const entries = fs.readdirSync(cur);
        for (const name of entries) {
          const child = path.join(cur, name);
          try {
            const st = fs.statSync(child);
            if (st.isDirectory()) {
              stack.push(child);
            } else if (st.isFile()) {
              const rel = path.relative(base, child).replace(/\\/g, '/');
              result.push({ full: child, relName: rel || path.basename(child) });
            }
          } catch (_) { /* ignore single file error */ }
        }
      }
    }
    return result;
  }

  try {
    const FormData = require('form-data');
    const formData = new FormData();
    // 后端读取 req.body.path 作为上传目录
    formData.append('path', targetPath);
    if (conflictStrategy === 'overwrite' || conflictStrategy === 'rename') {
      formData.append('conflictStrategy', conflictStrategy);
    }

    for (const p of paths) {
      const files = collectFilesFromPath(p);
      for (const f of files) {
        formData.append('files', fs.createReadStream(f.full), { filename: f.relName });
      }
    }

    let urlObj;
    try {
      urlObj = new URL(uploadUrl);
    } catch (parseErr) {
      const msg = (parseErr && parseErr.message) || '无效的上传地址';
      showErrorDialog(msg);
      return { ok: false, error: msg };
    }
    const isHttps = urlObj.protocol === 'https:';
    const httpMod = require(isHttps ? 'https' : 'http');

    const headers = {
      ...formData.getHeaders(),
      Authorization: `Bearer ${token}`,
    };

    const requestOptions = {
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers,
      timeout: 0,
    };

    const data = await new Promise((resolve, reject) => {
      const req = httpMod.request(requestOptions, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch (_) {}
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errObj = new Error((parsed && parsed.error) || `上传失败 ${res.statusCode}`);
            errObj.code = parsed && parsed.code;
            errObj.conflicts = parsed && parsed.conflicts;
            reject(errObj);
          }
        });
      });

      req.on('error', (err) => {
        const msg = err && err.message ? err.message : String(err);
        showErrorDialog(msg);
        reject(err);
      });

      formData.pipe(req);
    });

    return { ok: true, files: (data && data.files) || [] };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (!(e && e.code === 'FILE_CONFLICT')) {
      showErrorDialog(msg);
    }
    return { ok: false, error: msg, code: e && e.code, conflicts: (e && e.conflicts) || [] };
  }
});

function parseOriginAndToken(downloadUrl) {
  try {
    const u = new URL(downloadUrl);
    const token = u.searchParams.get('token') || '';
    return { origin: u.origin, token };
  } catch (_) {
    return { origin: '', token: '' };
  }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

const DRAG_CACHE_ROOT = path.join(os.tmpdir(), 'shangpin-cloud-assets', 'drag-cache');
const dragTempBySender = new Map(); // sender.id -> string[]

function safeRemoveDragTemp(p) {
  try {
    if (!p) return;
    const resolved = path.resolve(p);
    const rootResolved = path.resolve(DRAG_CACHE_ROOT);
    const rel = path.relative(rootResolved, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (_) {}
}

ipcMain.on('drag-end', (event) => {
  try {
    const senderId = event && event.sender ? event.sender.id : null;
    if (!senderId) return;
    const arr = dragTempBySender.get(senderId) || [];
    dragTempBySender.delete(senderId);
    for (const p of arr) safeRemoveDragTemp(p);
  } catch (_) {}
});

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

async function downloadToFile(downloadUrl, destPath, onProgress) {
  ensureDir(path.dirname(destPath));
  const protocol = downloadUrl.startsWith('https') ? require('https') : require('http');
  await new Promise((resolve, reject) => {
    const req = protocol.get(downloadUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        if (loc) return resolve(downloadToFile(loc, destPath, onProgress));
        return reject(new Error('redirect without location'));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(destPath);
      const totalBytes = Number(res.headers['content-length'] || 0);
      let receivedBytes = 0;
      if (onProgress) onProgress({ receivedBytes, totalBytes });
      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (onProgress) onProgress({ receivedBytes, totalBytes });
      });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function listAllFilesInDir({ origin, token, dirRel }) {
  // 返回所有文件的相对路径（以 / 分隔）
  const files = [];
  const stack = [dirRel];
  while (stack.length) {
    const cur = stack.pop();
    const apiPath = encodeURIComponent(cur);
    const url = `${origin}/api/files?path=${apiPath}&token=${encodeURIComponent(token)}`;
    const items = await fetchJson(url);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it) continue;
      const childPath = String(it.path || '');
      if (!childPath) continue;
      if (it.isDir) stack.push(childPath);
      else files.push(childPath);
    }
  }
  return files;
}

ipcMain.on('ondragstart', async (event, paths, downloadUrls, isDirs) => {
  if (!paths || !Array.isArray(paths) || paths.length === 0) return;
  const fullPaths = [];
  const root = path.resolve(ASSETS_ROOT);
  const urls = Array.isArray(downloadUrls) ? downloadUrls : [];
  const dirFlags = Array.isArray(isDirs) ? isDirs : [];
  const createdTemps = [];
  const owner = event.sender ? BrowserWindow.fromWebContents(event.sender) : mainWindow;
  const dragDownloadId = downloadSerial++;
  const dragDownloadName = paths.length > 1 ? `${paths.length} 个文件` : (String(paths[0] || '').split(/[\\/]/).pop() || '正在准备文件');
  let dragReceivedBytes = 0;
  let dragTotalBytes = 0;
  const emitDragProgress = (state, patch = {}) => {
    sendDownloadProgress(owner || mainWindow, {
      id: dragDownloadId,
      url: 'drag-download',
      filename: dragDownloadName,
      state,
      totalBytes: dragTotalBytes,
      receivedBytes: dragReceivedBytes,
      ...patch,
    });
  };
  const addDragFileProgress = ({ receivedBytes, totalBytes }, baseReceived, baseTotal) => {
    if (totalBytes > 0) dragTotalBytes = Math.max(dragTotalBytes, baseTotal + totalBytes);
    dragReceivedBytes = baseReceived + receivedBytes;
    emitDragProgress('progress');
  };
  emitDragProgress('started');
  // 本批次共用一个临时目录，其下用原始文件名/文件夹名，拖到桌面时名称不变
  const sessionDir = path.join(DRAG_CACHE_ROOT, String(Date.now()) + '_' + Math.random().toString(16).slice(2));
  let sessionCreated = false;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const rel = (p || '').replace(/^\//, '').replace(/\\/g, path.sep).replace(/\//g, path.sep).trim();
    if (!rel) continue;
    const full = path.resolve(root, rel);
    if (fs.existsSync(full)) {
      const relCheck = path.relative(root, full);
      if (!relCheck.startsWith('..') && !path.isAbsolute(relCheck)) fullPaths.push(full);
      continue;
    }
    const url = urls[i];
    const isDir = !!dirFlags[i];
    if (url && typeof url === 'string') {
      try {
        const baseName = path.basename(rel) || (isDir ? 'folder' : 'file');
        ensureDir(DRAG_CACHE_ROOT);
        if (!sessionCreated) {
          ensureDir(sessionDir);
          sessionCreated = true;
        }
        // 多选时用子目录 0、1、2… 避免同名文件覆盖；单条时直接用原名
        const destBase = paths.length > 1 ? path.join(sessionDir, String(i), baseName) : path.join(sessionDir, baseName);
        if (!isDir) {
          const ext = path.extname(rel) || '';
          const tmpPath = destBase + ext;
          ensureDir(path.dirname(tmpPath));
          const baseReceived = dragReceivedBytes;
          const baseTotal = dragTotalBytes;
          await downloadToFile(url, tmpPath, (progress) => addDragFileProgress(progress, baseReceived, baseTotal));
          if (fs.existsSync(tmpPath)) fullPaths.push(tmpPath);
          continue;
        }

        // 远程文件夹：递归下载到临时目录，目录名用原名
        const { origin, token } = parseOriginAndToken(url);
        if (!origin || !token) continue;
        const dirRel = String(p || '').replace(/\\/g, '/').replace(/^\//, '').trim();
        if (!dirRel) continue;
        const tmpBase = path.join(path.dirname(destBase), path.basename(destBase));
        ensureDir(tmpBase);
        const allFiles = await listAllFilesInDir({ origin, token, dirRel });
        for (const fileRel of allFiles) {
          const fileUrl = `${origin}/api/download?path=${encodeURIComponent(fileRel)}&token=${encodeURIComponent(token)}`;
          const relInside = fileRel.replace(dirRel, '').replace(/^[\\/]/, '');
          const dest = path.join(tmpBase, relInside.replace(/\//g, path.sep));
          const baseReceived = dragReceivedBytes;
          const baseTotal = dragTotalBytes;
          await downloadToFile(fileUrl, dest, (progress) => addDragFileProgress(progress, baseReceived, baseTotal));
        }
        fullPaths.push(tmpBase);
      } catch (e) {
        emitDragProgress('failed');
      }
    }
  }
  if (fullPaths.length === 0) {
    emitDragProgress('failed');
    return;
  }
  if (sessionCreated) {
    createdTemps.push(sessionDir);
  }
  const iconPath = path.join(__dirname, 'drag-icon.png');
  const hasIcon = fs.existsSync(iconPath);
  try {
    const opts = fullPaths.length === 1
      ? { file: fullPaths[0] }
      : { files: fullPaths };
    if (hasIcon) opts.icon = iconPath;
    try {
      const senderId = event && event.sender ? event.sender.id : null;
      if (senderId && createdTemps.length) dragTempBySender.set(senderId, createdTemps);
    } catch (_) {}
    event.sender.startDrag(opts);
    emitDragProgress('completed', {
      receivedBytes: dragTotalBytes > 0 ? dragTotalBytes : dragReceivedBytes,
      totalBytes: dragTotalBytes,
    });
  } catch (e) {
    console.error('startDrag failed:', e);
    emitDragProgress('failed');
  }
});

ipcMain.handle('open-file', async (_, relativePath, downloadUrl) => {
  if (!relativePath || typeof relativePath !== 'string') return { ok: false, err: '无效路径' };
  const normalized = relativePath.replace(/^\//, '').replace(/\//g, path.sep);
  const fullPath = path.join(ASSETS_ROOT, normalized);
  const ext = path.extname(fullPath).toLowerCase();
  let pathToOpen = fullPath;

  if (!fs.existsSync(fullPath) && downloadUrl && typeof downloadUrl === 'string') {
    try {
      const tmpDir = path.join(os.tmpdir(), 'shangpin-cloud-assets');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const baseName = path.basename(normalized) || 'file' + ext;
      const tmpPath = path.join(tmpDir, baseName);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpPath, buf);
      pathToOpen = tmpPath;
    } catch (e) {
      return { ok: false, err: '下载失败: ' + String(e && e.message ? e.message : e) };
    }
  }

  if (!fs.existsSync(pathToOpen)) return { ok: false, err: '文件不存在' };
  try {
    if (process.platform === 'win32' && (ext === '.bat' || ext === '.cmd')) {
      spawn('cmd.exe', ['/c', 'start', '', pathToOpen], { detached: true, stdio: 'ignore', cwd: path.dirname(pathToOpen) });
      return { ok: true };
    }
    const err = await shell.openPath(pathToOpen);
    return err ? { ok: false, err } : { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
});

ipcMain.handle('show-item-in-folder', async (_, relativePath, downloadUrl) => {
  if (!relativePath || typeof relativePath !== 'string') return { ok: false, err: '无效路径' };
  const normalized = relativePath.replace(/^\//, '').replace(/\//g, path.sep);
  const fullPath = path.join(ASSETS_ROOT, normalized);
  const ext = path.extname(fullPath).toLowerCase();
  let pathToShow = fullPath;

  if (!fs.existsSync(fullPath) && downloadUrl && typeof downloadUrl === 'string') {
    try {
      const tmpDir = path.join(os.tmpdir(), 'shangpin-cloud-assets');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const baseName = path.basename(normalized) || 'file' + ext;
      const tmpPath = path.join(tmpDir, baseName);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpPath, buf);
      pathToShow = tmpPath;
    } catch (e) {
      return { ok: false, err: '下载失败: ' + String(e && e.message ? e.message : e) };
    }
  }

  if (!fs.existsSync(pathToShow)) return { ok: false, err: '文件不存在' };
  try {
    // Windows/macOS/Linux：在文件管理器中定位到文件
    if (typeof shell.showItemInFolder === 'function') {
      shell.showItemInFolder(pathToShow);
      return { ok: true };
    }
    // 兜底：打开所在目录
    const err = await shell.openPath(path.dirname(pathToShow));
    return err ? { ok: false, err } : { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
});

process.on('uncaughtException', (err) => {
  startupLog('uncaughtException: ' + String(err && err.message ? err.message : err));
  try {
    dialog.showErrorBox('启动失败', String(err && err.message ? err.message : err));
  } catch (e) {}
  app.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  startupLog('unhandledRejection: ' + String(reason));
  try {
    dialog.showErrorBox('启动失败', String(reason));
  } catch (e) {}
  app.exit(1);
});

startupLog('3. 错误处理器已注册');

app.whenReady().then(async () => {
  startupLog('4. app.whenReady 已触发');
  try {
    if (isServerOnly) {
      startupLog('server-only mode starting.');
      const port = isDev ? await startServerDev() : await startServerProd();
      startupLog('server-only mode listening on port=' + port);
      return;
    }

    const serverConfig = loadServerConfig();
    startupLog('5. serverConfig: ' + (serverConfig ? '有' : '无'));
    let updateCheckBaseUrl = null;

    if (serverConfig) {
      startupLog('6. 远程模式，正在连接服务器...');
      const baseUrl = await resolveBaseUrl(serverConfig);
      startupLog('7. resolveBaseUrl 结果: ' + (baseUrl || 'null'));
      if (baseUrl) {
        startupLog('8. 创建窗口(远程)');
        createWindow(baseUrl, true);
        updateCheckBaseUrl = baseUrl;
      } else {
        startupLog('7b. 远程连接失败，切换到本地模式（见上方各 try xxx fail 原因）');
        if (!isDev) {
          try {
            dialog.showMessageBoxSync({
              type: 'warning',
              title: '未连接公司服务器',
              message: '当前为本地模式，看不到公司已有目录。',
              detail: '请确认：\n1) 公司主机已运行 启动服务端-公司主机.bat\n2) 本机与公司在同一局域网，或能访问公网地址\n3) 防火墙已放行 3798 端口\n\n启动日志中有各地址失败原因，路径见窗口标题栏说明。',
            });
          } catch (e) {}
        }
      }
    }

    if (!updateCheckBaseUrl) {
      startupLog('6. 本地模式，启动服务...');
      let port = PORT;
      if (isDev) {
        port = await startServerDev();
      } else {
        startupLog('7. 加载 server-bundle...');
        port = await startServerProd();
      }
      startupLog('8. 创建窗口(本地) port=' + port);
      createWindow(port, false);
      if (serverConfig && serverConfig.publicBaseUrl) {
        updateCheckBaseUrl = (serverConfig.publicBaseUrl || '').replace(/\/$/, '');
      }
    }

    if (updateCheckBaseUrl) {
      setTimeout(async () => {
        try {
          const r = await fetchCheckUpdate(updateCheckBaseUrl);
          const localVer = app.getVersion();
          if (!r.ok) return;
          if (!isNewerVersion(r.version, localVer)) return;
          // 同一版本 4 小时内已经提示过（含用户点了"稍后"或已触发过一次升级），不再重复弹窗
          if (shouldSkipUpdate(r.version)) return;
          if (!r.downloadUrl) {
            // 有新版本但服务端还没上传安装包，只在首次提示，之后静默
            writeUpdateSkip(r.version);
            dialog.showMessageBox({
              type: 'warning',
              title: '更新不可用',
              message: `检测到新版本 ${r.version}`,
              detail: `服务器尚未提供可下载的更新包${r.fileName ? `：${r.fileName}` : ''}。\n请先执行发布脚本后再试。`,
              buttons: ['知道了'],
            }).catch(() => {});
            return;
          }
          const msg = r.releaseNotes ? `发现新版本 ${r.version}\n\n${r.releaseNotes}\n\n是否立即更新？` : `发现新版本 ${r.version}，是否立即更新？`;
          const { response } = await dialog.showMessageBox({
            type: 'info',
            title: '更新',
            message: '发现新版本',
            detail: msg,
            buttons: ['立即更新', '稍后'],
          });
          // 无论用户选"稍后"还是"立即更新"，都写入 skip-cache，4 小时内不再弹窗：
          // - 稍后：避免下次启动立即又弹
          // - 立即更新：若升级失败 exe 版本未变，也避免重启后循环弹窗
          writeUpdateSkip(r.version);
          if (response === 0) {
            // 优先用本次实际连通的 baseUrl 拼接下载地址，避免路由器不支持 hairpin NAT
            // 时局域网客户端去请求公网 IP 导致下载卡死不动
            const effectiveDownloadUrl = (r.fileName && updateCheckBaseUrl)
              ? updateCheckBaseUrl.replace(/\/$/, '') + '/releases/' + encodeURIComponent(r.fileName)
              : r.downloadUrl;
            runUpdaterAndQuit(process.execPath, effectiveDownloadUrl);
          }
        } catch (e) {}
      }, 2000);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    startupLog('ERROR: ' + msg);
    try {
      const detail = msg.includes('等待服务启动超时')
        ? msg + '\n\n请检查：\n1) 端口 43123 是否被占用（关闭其他本程序或占用 43123 的程序）\n2) 终端中是否有 server 报错'
        : msg;
      dialog.showErrorBox('启动失败', detail);
    } catch (e) {}
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (!allowQuit) return;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});

app.on('before-quit', () => {
  allowQuit = true;
  if (trayBlinkTimer) clearInterval(trayBlinkTimer);
  trayBlinkTimer = null;
});
