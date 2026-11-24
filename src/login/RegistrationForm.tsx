import { useState, type FormEvent } from 'react';
import { registrationDepartments } from '../../user-manager/departments';

export default function RegistrationForm({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    setError('');
    if (form.get('password') !== form.get('confirm')) return setError('两次输入的密码不一致');
    setBusy(true);
    try {
      const res = await fetch('/api/registration-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), department: form.get('department'), password: form.get('password') }),
      });
      if (res.status !== 202) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '暂时无法提交，请稍后再试');
      }
      setSent(true);
    } catch (err) { setError(err instanceof Error ? err.message : '提交失败，请稍后再试'); }
    finally { setBusy(false); }
  }

  return <>
    {sent ? <p role="status" className="text-sm leading-6 text-slate-200">申请已受理。如已提交过，无需重复申请。审批和授权完成后即可登录。</p> : (
      <form onSubmit={submit}>
        <label htmlFor="register-name">用户名</label>
        <div className="nebula-login__field"><input id="register-name" name="username" autoComplete="username" required minLength={2} maxLength={32} placeholder="用中文姓名" /></div>
        <label htmlFor="register-dept">所在部门</label>
        <div className="nebula-login__field">
          <select id="register-dept" name="department" required defaultValue="">
            <option value="" disabled>请选择所在部门</option>
            {registrationDepartments.map(department => <option key={department} value={department}>{department}</option>)}
          </select>
        </div>
        <label htmlFor="register-password">密码</label>
        <div className="nebula-login__field"><input id="register-password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="至少 8 个字符" /></div>
        <label htmlFor="register-confirm">确认密码</label>
        <div className="nebula-login__field"><input id="register-confirm" name="confirm" type="password" autoComplete="new-password" required placeholder="再次输入密码" /></div>
        {error && <p role="alert" className="nebula-login__error">{error}</p>}
        <button className="nebula-login__submit" disabled={busy}>{busy ? '提交中…' : '提交注册申请'}</button>
      </form>
    )}
    <button type="button" className="mt-4 w-full text-sm text-sky-300 hover:underline" onClick={onBack}>返回登录</button>
  </>;
}
