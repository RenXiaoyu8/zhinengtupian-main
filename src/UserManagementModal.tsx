import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { User, UserPermissions } from './types';

import { chooseScope } from '../user-manager/scope-picker.mjs';
import { folderActions, scopeOf } from '../user-manager/asset-scopes.mjs';

const API_BASE = '/api';
type PermissionKey = Exclude<keyof UserPermissions, 'folderScopes'>;

type ManagedUser = {
  username: string;
  protectedPassword?: boolean;
  password: string;
  role: string;
  permissions: UserPermissions;
};

type Registration = { id: string; username: string; department: string; state: 'pending' | 'approved'; created_at: number; reviewed_by: string | null };

const basePermissions: UserPermissions = {
  canRename: false,
  canMove: false,
  canCreateFolder: false,
  canUpload: false,
  canDownload: true,
  canDelete: false,
  canManageProducts: false,
  canManageBrands: false,
  canTag: false,
  canManageUsers: false,
  canApproveRegistrations: false,
  canManageNewDevelopment: false,
  canSendNotification: false,
};

const permissionLabels: Array<[PermissionKey, string]> = [
  ['canUpload', '上传'],
  ['canCreateFolder', '新建文件夹'],
  ['canDownload', '下载'],
  ['canDelete', '删除'],
  ['canRename', '重命名'],
  ['canMove', '移动'],
  ['canManageProducts', '产品管理'],
  ['canManageBrands', '品牌管理'],
  ['canTag', '打标签'],
  ['canManageUsers', '账号权限管理'],
  ['canApproveRegistrations', '审批新成员'],
  ['canManageNewDevelopment', '新品流程设置'],
  ['canSendNotification', '发送通知'],
];

const departmentOptions = ['Admin', '设计部', '采购部', '运营部', '抖音部', '客服部', '摄影部', '经理', '经理助理', 'Viewer'];

const cloneManagedUser = (value: ManagedUser): ManagedUser => ({
  ...value,
  permissions: { ...value.permissions },
});

export default function UserManagementModal({ theme, user, onClose }: { theme: 'dark' | 'light'; user: User; onClose: () => void }) {
  const manager = !!user.permissions.canManageUsers || user.username === '任小雨';
  const [requests, setRequests] = useState<Registration[]>([]);
  const [activation, setActivation] = useState<Registration | null>(null);
  const [processing, setProcessing] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUsername, setSelectedUsername] = useState('');
  const [draft, setDraft] = useState<ManagedUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [newUser, setNewUser] = useState<ManagedUser>({
    username: '',
    password: '',
    role: 'Viewer',
    permissions: { ...basePermissions },
  });


  const cls = theme === 'dark'
    ? 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-sky-500'
    : 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-sky-500';

  const sortedUsers = useMemo(() => [...users].sort((a, b) => a.username.localeCompare(b.username, 'zh-CN')), [users]);

  const api = async (url: string, init?: RequestInit) => {
    const res = await fetch(`${API_BASE}${url}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.token}`,
        ...(init?.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const list = await api('/users');
      const normalized: ManagedUser[] = (list || []).map((u: any) => ({
        username: String(u.username || ''),
        password: String(u.password || ''),
        protectedPassword: !!u.protectedPassword,
        role: String(u.role || 'Viewer'),
        permissions: { ...basePermissions, ...(u.permissions || {}) },
      }));
      setUsers(normalized);
      setSelectedUsername(prev => {
        if (prev && normalized.some(item => item.username === prev)) return prev;
        return normalized[0]?.username || '';
      });
    } finally {
      setLoading(false);
    }
  };

  const refreshRequests = async () => {
    try {
      const rows = await api('/registration-requests');
      setRequests(rows);
      setQueueError('');
    } catch (err: any) { setQueueError(err.message); }
  };

  useEffect(() => {
    if (manager) loadUsers().catch(err => setQueueError(err.message));
    refreshRequests();
  }, [manager, user.token]);

  const review = async (row: Registration, action: 'approve' | 'reject' | 'discard') => {
    setProcessing(true);
    try {
      await api('/registration-requests/' + row.id + '/' + action, { method: 'POST' });
      if (activation?.id === row.id) { setActivation(null); setShowCreatePanel(false); }
      await refreshRequests();
    } catch (err: any) { setQueueError(err.message); }
    finally { setProcessing(false); }
  };

  function openCreate(row: Registration | null) {
    setActivation(row);
    setNewUser({ username: row?.username || '', password: '', role: 'Viewer',
      permissions: { ...basePermissions, canDownload: !row } });
    setShowCreatePanel(true);
  }

  useEffect(() => {
    const selected = sortedUsers.find(item => item.username === selectedUsername) || null;
    setDraft(selected ? cloneManagedUser(selected) : null);
  }, [selectedUsername, sortedUsers]);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(users.find(item => item.username === draft.username));

  const persistDraft = async (nextDraft: ManagedUser) => {
    setSaving(true);
    try {
      await api('/users', {
        method: 'PUT',
        body: JSON.stringify({
          username: nextDraft.username.trim(),
          password: nextDraft.password.trim(),
          role: nextDraft.role.trim() || 'Viewer',
          permissions: nextDraft.permissions,
        }),
      });
      const saved = cloneManagedUser(nextDraft);
      if (saved.protectedPassword) saved.password = '';
      setUsers(prev => prev.map(item => item.username === saved.username ? saved : item));
    } catch (err: any) {
      alert(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (patch: Partial<ManagedUser>) => {
    setDraft(prev => prev ? { ...prev, ...patch } : null);
  };

  const permissionEditor = (account: ManagedUser, change: (permissions: UserPermissions) => void) =>
    permissionLabels.map(([key, label]) => {
      const perms = account.permissions;
      const scope = scopeOf(perms, key);
      return (
        <div key={key} className="flex flex-wrap items-center justify-between gap-1 rounded border border-slate-500/30 px-2 py-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!perms[key]} onChange={e => change({ ...perms, [key]: e.target.checked })} />
            {label}
          </label>
          {folderActions.includes(key) && (
            <button type="button" aria-label={label + '权限范围'} className="text-xs text-sky-500 hover:underline" onClick={async () => {
              const next = await chooseScope(label, scope, (p: string) => api('/users/folders?path=' + encodeURIComponent(p)));
              if (next !== null) change({ ...perms, folderScopes: { ...perms.folderScopes, [key]: next } });
            }}>
              {scope === 'all' ? '全部范围' : `指定文件夹（${scope.length}）`}
            </button>
          )}
        </div>
      );
    });

  const deleteUser = async (username: string) => {
    if (!confirm(`确定删除用户「${username}」？`)) return;
    await api(`/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await loadUsers();
  };

  const createUser = async () => {
    if (!newUser.username.trim()) return alert('请填写用户名');
    if (!activation && !newUser.password.trim()) return alert('请填写密码');
    setCreatingUser(true);
    try {
      await api(activation ? '/registration-requests/' + activation.id + '/activate' : '/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUser.username.trim(),
          password: newUser.password.trim(),
          role: newUser.role.trim() || 'Viewer',
          permissions: newUser.permissions,
        }),
      });
      setNewUser({
        username: '',
        password: '',
        role: 'Viewer',
        permissions: { ...basePermissions },
      });
      setShowCreatePanel(false);
      setActivation(null);
      await refreshRequests();
      await loadUsers();
      setSelectedUsername(newUser.username.trim());
    } catch (err: any) {
      setQueueError(err.message);
    } finally {
      setCreatingUser(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div className={`max-h-[88vh] w-full max-w-6xl overflow-y-auto rounded-xl border p-5 shadow-2xl ${theme === 'dark' ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold">{manager ? '账号权限设置' : '审批新成员'}</h3>
            {manager && <p className="mt-1 text-xs text-slate-500">选择账号后设置权限和目录范围，点击“保存修改”生效。</p>}
          </div>
          <div className="flex items-center gap-2">
            {manager && <button
              type="button"
              onClick={() => showCreatePanel && !activation ? setShowCreatePanel(false) : openCreate(null)}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500"
            >
              <Plus className="h-4 w-4" />
              新建账号
            </button>}
            <button aria-label="关闭成员管理" onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-800 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <section className="mb-5 rounded-xl border border-slate-500/30 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold">新成员申请（{requests.length}）</h4>
            <button type="button" onClick={refreshRequests} className="text-xs text-sky-500">刷新申请</button>
          </div>
          {queueError && <p role="alert" className="my-2 text-sm text-red-500">{queueError}</p>}
          {!requests.length && !queueError && <p className="text-xs text-slate-500">暂无待处理申请</p>}
          <div className="max-h-64 overflow-y-auto">{requests.map(row => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-500/20 py-2">
              <div className="min-w-0 break-words text-sm">
                <b>{row.username}</b> · {row.department}
                <p className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString()} · {row.state === 'approved' ? row.reviewed_by + ' 已通过，待授权' : '待审批'}</p>
              </div>
              <div className="flex gap-3 text-sm">
                {row.state === 'pending' && user.permissions.canApproveRegistrations && <>
                  <button disabled={processing} onClick={() => review(row, 'approve')} className="text-sky-500">通过申请</button>
                  <button disabled={processing} onClick={() => review(row, 'reject')} className="text-red-500">驳回申请</button>
                </>}
                {row.state === 'approved' && manager && <>
                  <button disabled={creatingUser} onClick={() => openCreate(row)} className="text-sky-500">配置权限</button>
                  <button disabled={processing || creatingUser} onClick={() => review(row, 'discard')} className="text-red-500">移除申请</button>
                </>}
              </div>
            </div>
          ))}</div>
        </section>

        {manager && <>
        <datalist id="account-role-list">
          {departmentOptions.map(role => <option key={role} value={role} />)}
        </datalist>

        {showCreatePanel && (
          <div className={`mb-5 rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
            <div className="mb-3 text-sm font-bold">{activation ? '为 ' + activation.username + ' 配置权限' : '新建账号'}</div>
            <div className="grid gap-3 lg:grid-cols-3">
              <input className={cls} disabled={!!activation} placeholder="用户名" value={newUser.username} onChange={e => setNewUser(prev => ({ ...prev, username: e.target.value }))} />
              {!activation && <input type="text" autoComplete="off" className={cls} placeholder="密码" value={newUser.password} onChange={e => setNewUser(prev => ({ ...prev, password: e.target.value }))} />}
              <input className={cls} list="account-role-list" placeholder="部门/角色" value={newUser.role} onChange={e => setNewUser(prev => ({ ...prev, role: e.target.value }))} />
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {permissionEditor(newUser, permissions => setNewUser(prev => ({ ...prev, permissions })))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={createUser}
                disabled={creatingUser}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {creatingUser ? '保存中…' : activation ? '保存权限并开通' : '创建'}
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[1.3fr_0.9fr]">
          <section className={`rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-slate-50'}`}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold">{draft?.username || '未选择账号'}</div>
                <div className="mt-1 text-xs text-slate-500">{saving ? '正在保存…' : dirty ? '有未保存的修改' : ''}</div>
              </div>
              {draft && (
                <div className="flex items-center gap-2">
                <button disabled={saving || !dirty} onClick={() => persistDraft(draft)} className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white disabled:opacity-50">保存修改</button>
                <button onClick={() => deleteUser(draft.username)} className="rounded-lg p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button></div>
              )}
            </div>

            {draft ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="space-y-1 text-sm font-semibold">
                    用户名
                    <input className={cls} value={draft.username} disabled />
                  </label>
                  <label className="space-y-1 text-sm font-semibold">
                    密码
                    <input type={draft.protectedPassword ? 'password' : 'text'} autoComplete="off" className={cls} placeholder={draft.protectedPassword ? '已设置，留空不修改' : ''} value={draft.password} onChange={e => updateDraft({ password: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm font-semibold">
                    部门/角色
                    <input className={cls} list="account-role-list" value={draft.role} onChange={e => updateDraft({ role: e.target.value })} />
                  </label>
                </div>

                <div className={`rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-white'}`}>
                  <div className="mb-3 text-sm font-bold">权限</div>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    {permissionEditor(draft, permissions => updateDraft({ permissions }))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-64 items-center justify-center text-sm text-slate-500">右边选择一个账号后，在这里编辑。</div>
            )}
          </section>

          <section className={`rounded-xl border ${theme === 'dark' ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-slate-50'}`}>
            <div className={`border-b px-4 py-3 text-sm font-bold ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
              账号列表 {loading ? '加载中...' : `(${sortedUsers.length})`}
            </div>
            <div className="max-h-[62vh] overflow-y-auto p-2">
              {sortedUsers.map(item => {
                const active = item.username === selectedUsername;
                return (
                  <button
                    key={item.username}
                    type="button"
                    onClick={() => setSelectedUsername(item.username)}
                    className={`mb-2 w-full rounded-xl border p-3 text-left transition ${
                      active
                        ? 'border-sky-500 bg-sky-500/10'
                        : theme === 'dark'
                          ? 'border-slate-800 bg-slate-900 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="font-bold">{item.username}</div>
                    <div className="mt-1 text-xs text-slate-500">{item.role}</div>
                    <div className="mt-1 text-xs text-slate-500">密码：{item.protectedPassword ? '已设置' : item.password || '未设置'}</div>
                    <div className="mt-2 text-[11px] text-slate-500">
                      {permissionLabels.filter(([key]) => item.permissions[key]).map(([, label]) => label).join('、') || '无权限'}
                    </div>
                  </button>
                );
              })}
              {!sortedUsers.length && (
                <div className="px-3 py-8 text-center text-sm text-slate-500">暂无账号</div>
              )}
            </div>
          </section>
        </div>
        </>}
      </div>
    </div>
  );
}
