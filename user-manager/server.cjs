/**
 * 用户管理小工具 - 独立运行，不依赖主程序
 * 用法：在该目录下执行 node server.cjs，或双击 启动用户管理.bat
 * 会打开浏览器，在页面里添加/删除/编辑用户及权限，直接读写 users.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { childFolders, validScopes } = require('./folder-access.cjs');
const APP_DATA_FOLDER = '程序图片勿动';

// 解析 users.json 路径：优先 config.json 的 assetsRoot，其次环境变量 ASSETS_ROOT，再次默认 D:\尚品易站图片
// 仅使用「程序图片勿动\users.json」，不再回退到项目根目录，避免主程序与用户管理工具读写两份数据。
function getUsersJsonPath() {
  const dir = __dirname;
  let assetsRoot = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';
  try {
    const configPath = path.join(dir, 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.assetsRoot) assetsRoot = cfg.assetsRoot;
    }
  } catch (_) {}
  const p = path.join(assetsRoot, APP_DATA_FOLDER, 'users.json');
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) {
    try { fs.mkdirSync(parent, { recursive: true }); } catch (_) {}
  }
  return p;
}

const USERS_JSON = getUsersJsonPath();

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_JSON)) return [];
    const raw = fs.readFileSync(USERS_JSON, 'utf-8').replace(/^\uFEFF/, '').trim();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('读取 users.json 失败:', e.message);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_JSON, JSON.stringify(users, null, 2), 'utf-8');
}

const { resetPassword } = require('./registration-password.cjs');
const PERM_KEYS = ['canApproveRegistrations', 'canUpload', 'canRename', 'canMove', 'canCreateFolder', 'canDownload', 'canDelete', 'canManageProducts', 'canManageBrands', 'canTag'];

function effectivePermissions(user) {
  const role = String(user.role || '').toLowerCase();
  const editor = role === 'admin' || role === 'editor';
  const upload = user.permissions?.canUpload ?? editor;
  return {
    canApproveRegistrations: role === 'admin', canCreateFolder: role === 'admin', canUpload: upload, canRename: upload, canMove: upload,
    canDownload: true, canDelete: editor, canManageProducts: editor, canManageBrands: editor,
    canTag: editor, ...user.permissions,
  };
}

function mergePermissions(current, changes) {
  const permissions = { ...current };
  for (const key of PERM_KEYS) {
    if (Object.hasOwn(changes, key)) permissions[key] = changes[key] === true;
  }
  if (changes.folderScopes !== undefined) permissions.folderScopes = changes.folderScopes;
  return permissions;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (ch) => { buf += ch; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (_) { resolve({}); }
    });
  });
}

// 无请求超过此毫秒数则自动退出，释放端口（页面会定时发心跳，关掉浏览器后心跳停止即触发）
const IDLE_EXIT_MS = 2 * 60 * 1000;
let lastActivity = Date.now();

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  const url = req.url.split('?')[0];
  const q = new URL(req.url, 'http://localhost').searchParams;

  // 心跳：页面定时请求，用于判断浏览器是否已关闭
  if (url === '/api/ping' && req.method === 'GET') {
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (url === '/scope-picker.mjs' || url === '/asset-scopes.mjs')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, url.slice(1))));
  }
  if (req.method === 'GET' && url === '/api/users/folders') {
    try { return send(res, 200, await childFolders(path.dirname(path.dirname(USERS_JSON)), q.get('path') || '')); }
    catch { return send(res, 400, { error: '无法读取目录' }); }
  }
  // 静态页
  if (url === '/' || url === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404);
      res.end('未找到 index.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath, 'utf-8'));
    return;
  }

  // API: 获取用户列表（含密码，便于本地查看与编辑）
  if (url === '/api/users' && req.method === 'GET') {
    const users = loadUsers();
    const list = users.map((u) => ({
      username: u.username,
      password: u.password || '',
      protectedPassword: !!u.passwordHash,
      role: u.role || 'Viewer',
      permissions: effectivePermissions(u),
    }));
    return send(res, 200, list);
  }

  // API: 添加用户
  if (url === '/api/users' && req.method === 'POST') {
    const body = await parseBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!username || !password) return send(res, 400, { error: '用户名和密码不能为空' });
    const users = loadUsers();
    if (users.some((u) => String(u.username).trim() === username)) return send(res, 400, { error: '用户名已存在' });
    const perms = body.permissions || {};
    if (!validScopes(perms.folderScopes)) return send(res, 400, { error: '权限范围无效' });
    users.push({
      username,
      password,
      role: (body.role || 'Viewer').trim(),
      permissions: mergePermissions({}, perms),
    });
    saveUsers(users);
    return send(res, 200, { success: true });
  }

  // API: 更新用户
  if (url === '/api/users' && req.method === 'PUT') {
    const body = await parseBody(req);
    const username = String(body.username || '').trim();
    if (!username) return send(res, 400, { error: '请指定用户名' });
    const users = loadUsers();
    const i = users.findIndex((u) => String(u.username).trim() === username);
    if (i < 0) return send(res, 404, { error: '用户不存在' });
    if (typeof body.password === 'string' && body.password.trim()) {
      if (users[i].passwordHash) users[i].passwordHash = resetPassword(body.password.trim());
      else users[i].password = body.password.trim();
    }
    if (typeof body.role === 'string' && body.role.trim()) users[i].role = body.role.trim();
    if (body.permissions && typeof body.permissions === 'object') {
      if (!validScopes(body.permissions.folderScopes)) return send(res, 400, { error: '权限范围无效' });
      users[i].permissions = mergePermissions(users[i].permissions, body.permissions);
    }
    saveUsers(users);
    return send(res, 200, { success: true });
  }

  // API: 删除用户
  if (url === '/api/users' && req.method === 'DELETE') {
    const username = q.get('username') || '';
    if (!username.trim()) return send(res, 400, { error: '请指定要删除的用户名' });
    const users = loadUsers();
    const admins = users.filter((u) => (u.role || '').toString().toLowerCase() === 'admin');
    if (admins.length <= 1 && admins.some((u) => String(u.username).trim() === username)) {
      return send(res, 400, { error: '不能删除最后一名管理员' });
    }
    const next = users.filter((u) => String(u.username).trim() !== username);
    if (next.length === users.length) return send(res, 404, { error: '用户不存在' });
    saveUsers(next);
    return send(res, 200, { success: true });
  }

  send(res, 404, { error: 'Not Found' });
});

// 使用 0 由系统分配空闲端口，避免 3799 被占用时报错
server.listen(0, '127.0.0.1', () => {
  const actual = server.address().port;
  const url = `http://127.0.0.1:${actual}`;
  console.log('用户管理工具已启动: ' + url);
  console.log('users.json 路径: ' + USERS_JSON);
  console.log('关闭浏览器或 2 分钟无访问将自动退出并释放端口。');
  try {
    const op = require('child_process');
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    op.exec(cmd + ' ' + url);
  } catch (_) {}

  const checkIdle = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      clearInterval(checkIdle);
      console.log('无访问超时，自动退出并释放端口。');
      process.exit(0);
    }
  }, 15000);
});
