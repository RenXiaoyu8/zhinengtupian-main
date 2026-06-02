import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { User, UserPermissions } from './types';

const API_BASE = '/api';

type ManagedUser = {
  username: string;
  password: string;
  role: string;
  permissions: UserPermissions;
};

const basePermissions: UserPermissions = {
  canUpload: false,
  canDownload: true,
  canDelete: false,
  canManageProducts: false,
  canManageBrands: false,
  canTag: false,
  canManageUsers: false,
  canManageNewDevelopment: false,
};

const permissionLabels: Array<[keyof UserPermissions, string]> = [
  ['canUpload', '上传'],
  ['canDownload', '下载'],
  ['canDelete', '删除'],
  ['canManageProducts', '产品管理'],
  ['canManageBrands', '品牌管理'],
  ['canTag', '打标签'],
  ['canManageUsers', '账号权限管理'],
  ['canManageNewDevelopment', '新品流程设置'],
];

const departmentOptions = ['Admin', '设计部', '采购部', '运营部', '抖音部', '客服部', '摄影部', '经理', '经理助理', 'Viewer'];

const cloneManagedUser = (value: ManagedUser): ManagedUser => ({
  ...value,
  permissions: { ...value.permissions },
});

export default function UserManagementModal({ theme, user, onClose }: { theme: 'dark' | 'light'; user: User; onClose: () => void }) {
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
  const saveTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    loadUsers().catch(err => alert(err.message));
  }, []);

  useEffect(() => {
    const selected = sortedUsers.find(item => item.username === selectedUsername) || null;
    setDraft(selected ? cloneManagedUser(selected) : null);
  }, [selectedUsername, sortedUsers]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

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
      setUsers(prev => prev.map(item => item.username === nextDraft.username ? cloneManagedUser(nextDraft) : item));
    } catch (err: any) {
      alert(err.message || '保存失败');
      await loadUsers();
    } finally {
      setSaving(false);
    }
  };

  const queueSave = (nextDraft: ManagedUser) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      persistDraft(nextDraft).catch(() => {});
    }, 350);
  };

  const updateDraft = (patch: Partial<ManagedUser>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const nextDraft: ManagedUser = {
        ...prev,
        ...patch,
        permissions: patch.permissions ? { ...patch.permissions } : prev.permissions,
      };
      queueSave(nextDraft);
      return nextDraft;
    });
  };

  const togglePermission = (key: keyof UserPermissions, checked: boolean) => {
    if (!draft) return;
    updateDraft({ permissions: { ...draft.permissions, [key]: checked } });
  };

  const deleteUser = async (username: string) => {
    if (!confirm(`确定删除用户「${username}」？`)) return;
    await api(`/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await loadUsers();
  };

  const createUser = async () => {
    if (!newUser.username.trim()) return alert('请填写用户名');
    if (!newUser.password.trim()) return alert('请填写密码');
    setCreatingUser(true);
    try {
      await api('/users', {
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
      await loadUsers();
    } finally {
      setCreatingUser(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div className={`max-h-[88vh] w-full max-w-6xl overflow-y-auto rounded-xl border p-5 shadow-2xl ${theme === 'dark' ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold">账号权限设置</h3>
            <p className="mt-1 text-xs text-slate-500">左边编辑当前账号，右边滚动选择账号。左边修改后自动保存。</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCreatePanel(prev => !prev)}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500"
            >
              <Plus className="h-4 w-4" />
              新建账号
            </button>
            <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-800 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <datalist id="account-role-list">
          {departmentOptions.map(role => <option key={role} value={role} />)}
        </datalist>

        {showCreatePanel && (
          <div className={`mb-5 rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
            <div className="mb-3 text-sm font-bold">新建账号</div>
            <div className="grid gap-3 lg:grid-cols-3">
              <input className={cls} placeholder="用户名" value={newUser.username} onChange={e => setNewUser(prev => ({ ...prev, username: e.target.value }))} />
              <input type="text" autoComplete="off" className={cls} placeholder="密码" value={newUser.password} onChange={e => setNewUser(prev => ({ ...prev, password: e.target.value }))} />
              <input className={cls} list="account-role-list" placeholder="部门/角色" value={newUser.role} onChange={e => setNewUser(prev => ({ ...prev, role: e.target.value }))} />
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {permissionLabels.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!newUser.permissions[key]}
                    onChange={e => setNewUser(prev => ({ ...prev, permissions: { ...prev.permissions, [key]: e.target.checked } }))}
                    className="h-4 w-4 accent-sky-500"
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={createUser}
                disabled={creatingUser}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {creatingUser ? '创建中' : '创建'}
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[1.3fr_0.9fr]">
          <section className={`rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-slate-50'}`}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold">{draft?.username || '未选择账号'}</div>
                <div className="mt-1 text-xs text-slate-500">{saving ? '正在自动保存...' : '修改后自动保存'}</div>
              </div>
              {draft && (
                <button onClick={() => deleteUser(draft.username)} className="rounded-lg p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
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
                    <input type="text" autoComplete="off" className={cls} value={draft.password} onChange={e => updateDraft({ password: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm font-semibold">
                    部门/角色
                    <input className={cls} list="account-role-list" value={draft.role} onChange={e => updateDraft({ role: e.target.value })} />
                  </label>
                </div>

                <div className={`rounded-xl border p-4 ${theme === 'dark' ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-white'}`}>
                  <div className="mb-3 text-sm font-bold">权限</div>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    {permissionLabels.map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!draft.permissions[key]}
                          onChange={e => togglePermission(key, e.target.checked)}
                          className="h-4 w-4 accent-sky-500"
                        />
                        {label}
                      </label>
                    ))}
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
                    <div className="mt-1 text-xs text-slate-500">密码：{item.password || '未设置'}</div>
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
      </div>
    </div>
  );
}
