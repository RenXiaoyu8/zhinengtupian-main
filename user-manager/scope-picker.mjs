// Shared by the desktop account editor and the standalone Windows account tool.
export function chooseScope(label, initial, listChildren) {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', label + '权限范围');
  dialog.style.cssText = 'margin:auto;padding:20px;border:1px solid #64748b;border-radius:12px;width:min(440px,92vw);max-height:85vh;overflow:auto;background:Canvas;color:CanvasText;color-scheme:light dark;font:14px system-ui;z-index:10000';
  const element = (tag, text = '') => Object.assign(document.createElement(tag), { textContent: text });
  const title = element('h3', label + '权限范围');
  title.style.cssText = 'font-size:17px;font-weight:600;margin:0 0 12px';
  const mode = element('select');
  mode.setAttribute('aria-label', '范围类型');
  mode.append(new Option('全部范围', 'all'), new Option('指定文件夹', 'folders'));
  mode.value = initial === 'all' ? 'all' : 'folders';
  let selected = new Set(Array.isArray(initial) ? initial : []);
  const expanded = new Set(['']);
  const children = new Map();
  const errors = new Map();
  const body = element('div');
  body.style.cssText = 'margin:12px 0;max-height:46vh;overflow:auto';
  const summary = element('div');
  const footer = element('div');
  footer.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;margin-top:16px';
  const button = (text, action) => {
    const b = element('button', text);
    b.type = 'button';
    b.style.cssText = 'padding:3px 8px;cursor:pointer;border:1px solid #8888;border-radius:5px';
    b.onclick = action;
    return b;
  };
  const load = async parent => {
    if (children.has(parent)) return;
    children.set(parent, null);
    errors.delete(parent);
    try { children.set(parent, await listChildren(parent)); }
    catch { errors.set(parent, true); }
    if (dialog.open) render();
  };
  function render() {
    body.replaceChildren();
    summary.replaceChildren();
    if (mode.value === 'all') return;
    summary.append(element('p', '所选文件夹包含其下所有层级。'));
    for (const p of selected) {
      const remove = button(p + ' ×', () => { selected.delete(p); render(); });
      remove.title = '移除 ' + p;
      summary.append(remove);
    }
    function branch(parent, depth) {
      if (!children.has(parent)) void load(parent);
      if (errors.has(parent)) {
        body.append(button('目录加载失败，重试', () => { children.delete(parent); render(); }));
        return;
      }
      const names = children.get(parent);
      if (!names?.length) {
        const note = element('div', names ? '没有子文件夹' : '正在读取目录…');
        note.style.paddingLeft = depth * 18 + 8 + 'px'; body.append(note); return;
      }
      for (const name of names) {
        const p = parent ? parent + '/' + name : name;
        const row = element('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;padding-left:' + depth * 18 + 'px';
        const toggle = button(expanded.has(p) ? '▾' : '▸', () => {
          if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
          render();
        });
        toggle.setAttribute('aria-label', (expanded.has(p) ? '收起 ' : '展开 ') + p);
        toggle.setAttribute('aria-expanded', String(expanded.has(p)));
        const choice = element('input'); choice.type = 'checkbox';
        const inherited = [...selected].some(root => p.startsWith(root + '/'));
        choice.checked = inherited || selected.has(p); choice.disabled = inherited;
        choice.indeterminate = !choice.checked && [...selected].some(root => root.startsWith(p + '/'));
        choice.onchange = () => {
          if (choice.checked) {
            selected = new Set([...selected].filter(root => !root.startsWith(p + '/')));
            selected.add(p);
          } else selected.delete(p);
          render();
        };
        const caption = element('label');
        caption.append(choice, document.createTextNode(' ' + name));
        row.append(toggle, caption); body.append(row);
        if (expanded.has(p)) branch(p, depth + 1);
      }
    }
    branch('', 0);
  }
  mode.onchange = render;
  dialog.append(title, mode, summary, body, footer);
  document.body.append(dialog);
  return new Promise(resolve => {
    const finish = value => {
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.onclose = () => finish(null);
    footer.append(button('取消', () => finish(null)),
      button('确定范围', () => finish(mode.value === 'all' ? 'all' : [...selected])));
    dialog.showModal();
    render();
  });
}
