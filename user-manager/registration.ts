import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import passwords from './registration-password.cjs';
import { registrationDepartments } from './departments';

export function mountRegistrationRoutes(app, { db, authenticate, canApprove, canManage, loadUsers, saveUsers, validScopes, permissionBodyLimit }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, username TEXT NOT NULL, department TEXT NOT NULL,
      password_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
      reviewed_by TEXT, reviewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS registration_limits (
      source TEXT PRIMARY KEY, started INTEGER NOT NULL, attempts INTEGER NOT NULL
    );
  `);
  const router = express.Router();
  const nameKey = (s: string) => s.trim().normalize('NFKC').toLowerCase();
  const day = 86400000;
  const existingUser = (key: string) => loadUsers().find(u => nameKey(u.username) === key);
  const expire = () => {
    const now = Date.now();
    db.prepare("DELETE FROM registration_requests WHERE (state='pending' AND created_at < ?) OR (state='rejected' AND reviewed_at < ?)").run(now - 30 * day, now - day);
  };
  const limitWindow = 10 * 60000;
  const admit = db.transaction((peer: string) => {
    const now = Date.now();
    db.prepare('DELETE FROM registration_limits WHERE started <= ?').run(now - limitWindow);
    const count = db.prepare('SELECT attempts FROM registration_limits WHERE source=?');
    const increment = db.prepare('INSERT INTO registration_limits VALUES (?, ?, 1) ON CONFLICT(source) DO UPDATE SET attempts=attempts+1');
    if ((count.get('*')?.attempts || 0) >= 100 || (count.get(peer)?.attempts || 0) >= 6) return false;
    increment.run('*', now);
    increment.run(peer, now);
    return true;
  });
  const json = express.json({ limit: '8kb', inflate: false });
  let hashing = 0;
  router.post('/', (req, res, next) => {
    const peer = createHash('sha256').update(req.socket.remoteAddress || 'unknown').digest('hex');
    if (!admit.immediate(peer)) return res.set('Retry-After', '600').status(429).json({ error: '申请过于频繁，请在 10 分钟后再试' });
    if (!req.is('application/json')) return res.status(415).json({ error: '请使用注册表单提交' });
    next();
  }, json, async (req, res, next) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim().normalize('NFKC') : '';
    const key = nameKey(username);
    const pass = body.password;
    const department = typeof body.department === 'string' ? body.department.trim() : '';
    if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username) || ['任小雨','管理员','admin'].includes(key)) {
      return res.status(400).json({ error: '请使用 2–32 位的个人用户名，可用中文、字母、数字、下划线或短横线' });
    }
    if (!registrationDepartments.includes(department)) return res.status(400).json({ error: '请选择有效的所在部门' });
    if (typeof pass !== 'string' || pass.length < 8 || pass.length > 128 || pass !== pass.trim()) {
      return res.status(400).json({ error: '密码须为 8–128 个字符，首尾不能有空格' });
    }
    const occupied = () => existingUser(key) || db.prepare('SELECT 1 FROM registration_requests WHERE name_key=?').get(key);
    const full = () => db.prepare("SELECT COUNT(*) AS n FROM registration_requests WHERE state!='rejected'").get().n >= 200;
    expire();
    if (occupied()) return res.sendStatus(202);
    if (hashing >= 4 || full()) return res.status(429).json({ error: '申请较多，请稍后再试' });
    hashing++;
    try {
      const hash = await passwords.hashPassword(pass);
      const insert = db.transaction(() => {
        if (occupied()) return true;
        if (full()) return false;
        db.prepare("INSERT INTO registration_requests (id,name_key,username,department,password_hash,state,created_at) VALUES (?,?,?,?,?,'pending',?)")
          .run(randomUUID(), key, username, department, hash, Date.now());
        return true;
      });
      if (!insert.immediate()) return res.status(429).json({ error: '申请较多，请稍后再试' });
      res.sendStatus(202);
    } catch (err) { next(err); }
    finally { hashing--; }
  });

  router.use(authenticate);
  router.get('/', (req, res) => {
    const review = canApprove(req), manage = canManage(req);
    if (!review && !manage) return res.sendStatus(403);
    expire();
    res.json(db.prepare(`SELECT id, username, department, state, created_at, reviewed_by FROM registration_requests
      WHERE (state='pending' AND ?) OR (state='approved' AND ?) ORDER BY created_at`).all(+review, +manage));
  });
  const permissionJson = express.json({ limit: permissionBodyLimit });
  router.post('/:id/:action', (req, res, next) => {
    const { action } = req.params;
    if (!['approve', 'reject', 'activate', 'discard'].includes(action)) return res.sendStatus(404);
    const needsManagement = action === 'activate' || action === 'discard';
    if (!(needsManagement ? canManage(req) : canApprove(req))) return res.sendStatus(403);
    if (action === 'activate') return permissionJson(req, res, next);
    next();
  }, (req, res) => {
    const { id, action } = req.params;
    const result = db.transaction(() => {
      expire();
      const row = db.prepare('SELECT * FROM registration_requests WHERE id=?').get(id);
      if (!row) return [409, '申请已处理或已过期，请刷新'];
      if (((action === 'approve' || action === 'reject') && row.state === 'pending') || (action === 'discard' && row.state === 'approved')) {
        const approved = action === 'approve';
        db.prepare('UPDATE registration_requests SET state=?, reviewed_by=?, reviewed_at=?, password_hash=? WHERE id=?')
          .run(approved ? 'approved' : 'rejected', (req as typeof req & { user: { username: string } }).user.username,
            Date.now(), approved ? row.password_hash : '', id);
        return [200];
      }
      if (action !== 'activate' || row.state !== 'approved') return [409, '申请状态已改变，请刷新'];
      const { role, permissions } = req.body || {};
      if (typeof role !== 'string' || !role.trim() || role.length > 40 || !permissions || typeof permissions !== 'object' ||
        Array.isArray(permissions) || !validScopes(permissions.folderScopes) ||
        Object.entries(permissions).some(([k,v]) => k !== 'folderScopes' && (!permissionKeys.includes(k) || typeof v !== 'boolean'))) {
        return [400, '部门或权限设置无效'];
      }
      const users = loadUsers();
      const account = users.find(u => nameKey(u.username) === row.name_key);
      if (account && account.registrationId !== id) return [409, '已有同名账号，请核实后移除此申请'];
      if (!account) {
        const granted = Object.fromEntries(permissionKeys.map(k => [k, permissions[k] === true]));
        saveUsers([...users, { username: row.username, role: role.trim(), registrationId: id, password: '',
          passwordHash: row.password_hash, permissions: { ...granted, folderScopes: permissions.folderScopes } }]);
      }
      db.prepare('DELETE FROM registration_requests WHERE id=?').run(id);
      return [200];
    }).immediate();
    if (result[0] !== 200) return res.status(result[0]).json({ error: result[1] });
    res.json({ success: true });
  });
  router.use((err, _req, res, _next) => {
    const status = err.status === 413 ? 413 : err.status === 400 ? 400 : err.status === 415 ? 415 : 500;
    if (status === 500) console.error('Registration operation failed', err.message);
    res.status(status).json({ error: status === 500 ? '暂时无法处理申请，请稍后重试' : '申请资料格式或大小无效' });
  });
  app.use('/api/registration-requests', router);
}

const permissionKeys = ['canUpload', 'canDownload', 'canRename', 'canDelete', 'canMove', 'canCreateFolder',
  'canManageProducts', 'canManageBrands', 'canTag', 'canManageUsers', 'canApproveRegistrations', 'canManageNewDevelopment', 'canSendNotification'];
