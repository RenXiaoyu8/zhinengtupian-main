import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';

type Props = {
  path: string;
  token: string;
  theme: 'light' | 'dark';
  placeholder: string;
  onCreated: () => void;
  onCancel?: () => void;
};

export default function CreateFolderField({ path, token, theme, placeholder, onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const compact = !onCancel;

  async function createFolder() {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, name: name.trim() }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error || '创建失败');
        return;
      }
      if (input.current) {
        setName('');
        onCreated();
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className={compact ? 'flex gap-2' : 'space-y-4'}>
        <input
          ref={input}
          aria-label="文件夹名称"
          aria-invalid={!!error}
          autoFocus={!compact}
          readOnly={saving}
          placeholder={placeholder}
          className={`min-w-0 rounded-lg border outline-none focus:ring-2 ${compact ? 'flex-1 px-2 py-1 text-[10px] focus:ring-indigo-500' : 'w-full px-4 py-2 focus:ring-sky-500'} ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
          value={name}
          onChange={e => { setName(e.target.value); setError(''); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault();
              void createFolder();
            }
          }}
        />
        <div className={compact ? 'flex' : 'flex gap-3'}>
          <button type="button" aria-label="创建文件夹" disabled={!name.trim() || saving} onClick={createFolder}
            className={`text-white font-bold disabled:opacity-50 ${compact ? 'px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500' : 'flex-1 py-2 rounded-lg bg-sky-600 hover:bg-sky-500'}`}>
            {compact ? <Plus className="w-3 h-3" /> : '创建'}
          </button>
          {onCancel && (
            <button type="button" disabled={saving} onClick={onCancel}
              className={`flex-1 py-2 rounded-lg font-bold ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              取消
            </button>
          )}
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
