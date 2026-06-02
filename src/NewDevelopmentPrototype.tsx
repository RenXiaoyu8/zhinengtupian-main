import React, { useMemo, useState } from 'react';
import { Check, FileText, Image as ImageIcon, Plus, RotateCcw, Send, X } from 'lucide-react';

type Stage = 'initiation' | 'selling' | 'purchase' | 'packaging' | 'mainDetail' | 'leaderReview' | 'opsReview' | 'done';
type TestItem = { name: string; feasible: 'pending' | 'yes' | 'no' | 'outsourced'; note: string };
type Project = {
  id: number;
  stage: Stage;
  productName: string;
  barcode: string;
  standard: string;
  brand: string;
  spec: string;
  targetDate: string;
  sellingPoints: string[];
  testItems: TestItem[];
  copyConfirmed: boolean;
  testsConfirmed: boolean;
  packageSource: string;
  packagePreview: string;
  whiteImages: string[];
  designer: string;
  selfReview: string;
  mainImages: string[];
  detailPages: string[];
  leaderComment: string;
  leaderImages: string[];
  opsComment: string;
  opsImages: string[];
  history: string[];
};

const stages: { key: Stage; label: string }[] = [
  { key: 'initiation', label: '立项' },
  { key: 'selling', label: '运营卖点/检测项' },
  { key: 'purchase', label: '采购审核' },
  { key: 'packaging', label: '包装设计/白底图' },
  { key: 'mainDetail', label: '主图详情设计' },
  { key: 'leaderReview', label: '组长审核' },
  { key: 'opsReview', label: '运营审核' },
  { key: 'done', label: '完成' },
];

const blankProject = (): Project => ({
  id: Date.now(), stage: 'initiation', productName: '', barcode: '', standard: '', brand: '', spec: '', targetDate: '',
  sellingPoints: [''], testItems: [{ name: '', feasible: 'pending', note: '' }], copyConfirmed: false, testsConfirmed: false,
  packageSource: '', packagePreview: '', whiteImages: [''], designer: '', selfReview: '', mainImages: [''], detailPages: [''],
  leaderComment: '', leaderImages: [''], opsComment: '', opsImages: [''], history: ['创建新品开发项目']
});

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-sky-500';
const lightInputCls = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-sky-500';

function ArrayEditor({ title, values, onChange, placeholder, theme }: { title: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; theme: 'dark' | 'light' }) {
  const cls = theme === 'dark' ? inputCls : lightInputCls;
  return <div className="space-y-2">
    <div className="flex items-center justify-between"><label className="text-sm font-bold text-slate-400">{title}</label><button className="text-xs text-sky-400" onClick={() => onChange([...values, ''])}>+ 添加一行</button></div>
    {values.map((v, i) => <div key={i} className="flex gap-2"><input className={cls} value={v} placeholder={placeholder} onChange={e => onChange(values.map((x, idx) => idx === i ? e.target.value : x))} /><button className="px-2 text-slate-500 hover:text-red-400" onClick={() => onChange(values.filter((_, idx) => idx !== i).length ? values.filter((_, idx) => idx !== i) : [''])}><X className="w-4 h-4" /></button></div>)}
  </div>;
}

export default function NewDevelopmentPrototype({ theme = 'dark' as 'dark' | 'light' }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<Project>(blankProject());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = useMemo(() => projects.find(p => p.id === selectedId) || null, [projects, selectedId]);
  const cls = theme === 'dark' ? inputCls : lightInputCls;
  const panel = theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const muted = theme === 'dark' ? 'text-slate-400' : 'text-slate-500';

  const updateProject = (fn: (p: Project) => Project) => setProjects(prev => prev.map(p => p.id === selectedId ? fn(p) : p));
  const createProject = () => {
    if (!draft.productName.trim() || !draft.barcode.trim() || !draft.standard.trim()) return alert('立项必须填写：产品名称、条码、执行标准');
    const p = { ...draft, id: Date.now(), history: [...draft.history, '立项信息已保存'] };
    setProjects(prev => [p, ...prev]); setSelectedId(p.id); setDraft(blankProject());
  };
  const next = () => {
    if (!selected) return;
    const order: Stage[] = ['initiation','selling','purchase','packaging','mainDetail','leaderReview','opsReview','done'];
    if (selected.stage === 'selling' && (!selected.sellingPoints.some(Boolean) || !selected.testItems.some(t => t.name.trim()))) return alert('请至少填写一条卖点和一条检测项目');
    if (selected.stage === 'packaging' && (!selected.copyConfirmed || !selected.testsConfirmed || !selected.packageSource || !selected.packagePreview)) return alert('请确认文案/检测项目，并填写包装源文件和预览图');
    if (selected.stage === 'packaging' && !selected.whiteImages.some(Boolean)) return alert('白底图至少上传1张才可进入下一步');
    if (selected.stage === 'mainDetail' && (!selected.designer || !selected.selfReview || !selected.mainImages.some(Boolean) || !selected.detailPages.some(Boolean))) return alert('请分配设计师，填写自审提示词，并上传主图和详情页');
    const ns = order[order.indexOf(selected.stage) + 1];
    if (ns) updateProject(p => ({ ...p, stage: ns, history: [...p.history, `进入阶段：${stages.find(s => s.key === ns)?.label}`] }));
  };
  const reject = (role: 'leader' | 'ops') => {
    if (!selected) return;
    const comment = role === 'leader' ? selected.leaderComment : selected.opsComment;
    if (!comment.trim()) return alert('退回必须填写修改说明');
    updateProject(p => ({ ...p, stage: 'mainDetail', history: [...p.history, `${role === 'leader' ? '组长' : '运营'}退回：${comment}`] }));
  };

  const renderProjectForm = (p: Project) => {
    if (p.stage === 'initiation') return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {['productName:产品名称','barcode:条码','standard:执行标准','brand:品牌','spec:规格型号','targetDate:目标上市时间'].map(x => { const [k,l]=x.split(':') as [keyof Project,string]; return <label key={k as string} className="space-y-1 text-sm font-bold text-slate-400">{l}<input className={cls} value={String(p[k] || '')} onChange={e => updateProject(pr => ({ ...pr, [k]: e.target.value }))} /></label> })}
    </div>;
    if (p.stage === 'selling') return <div className="grid grid-cols-1 lg:grid-cols-2 gap-6"><ArrayEditor theme={theme} title="卖点信息（一条一行）" values={p.sellingPoints} placeholder="例如：316不锈钢材质，耐腐蚀" onChange={v => updateProject(pr => ({ ...pr, sellingPoints: v }))} /><div className="space-y-2"><div className="flex justify-between"><label className="text-sm font-bold text-slate-400">需检测项目</label><button className="text-xs text-sky-400" onClick={() => updateProject(pr => ({ ...pr, testItems: [...pr.testItems, { name: '', feasible: 'pending', note: '' }] }))}>+ 添加检测项</button></div>{p.testItems.map((t,i)=><div key={i} className="grid grid-cols-12 gap-2"><input className={`${cls} col-span-5`} value={t.name} placeholder="检测项目" onChange={e=>updateProject(pr=>({...pr,testItems:pr.testItems.map((it,idx)=>idx===i?{...it,name:e.target.value}:it)}))}/><select className={`${cls} col-span-3`} value={t.feasible} onChange={e=>updateProject(pr=>({...pr,testItems:pr.testItems.map((it,idx)=>idx===i?{...it,feasible:e.target.value as TestItem['feasible']}:it)}))}><option value="pending">待采购审核</option><option value="yes">可做</option><option value="no">不可做</option><option value="outsourced">需外协</option></select><input className={`${cls} col-span-4`} value={t.note} placeholder="备注" onChange={e=>updateProject(pr=>({...pr,testItems:pr.testItems.map((it,idx)=>idx===i?{...it,note:e.target.value}:it)}))}/></div>)}</div></div>;
    if (p.stage === 'purchase') return <div className="space-y-3">{p.testItems.map((t,i)=><div key={i} className={`grid grid-cols-12 gap-3 p-3 rounded-xl border ${panel}`}><div className="col-span-4 font-bold">{t.name || '未命名检测项'}</div><select className={`${cls} col-span-3`} value={t.feasible} onChange={e=>updateProject(pr=>({...pr,testItems:pr.testItems.map((it,idx)=>idx===i?{...it,feasible:e.target.value as TestItem['feasible']}:it)}))}><option value="pending">待定</option><option value="yes">可做</option><option value="no">不可做</option><option value="outsourced">需外协</option></select><input className={`${cls} col-span-5`} value={t.note} placeholder="成本/周期/原因" onChange={e=>updateProject(pr=>({...pr,testItems:pr.testItems.map((it,idx)=>idx===i?{...it,note:e.target.value}:it)}))}/></div>)}</div>;
    if (p.stage === 'packaging') return <div className="space-y-5"><div className="flex gap-6"><label className="flex items-center gap-2"><input type="checkbox" checked={p.copyConfirmed} onChange={e=>updateProject(pr=>({...pr,copyConfirmed:e.target.checked}))}/> 文案已确认</label><label className="flex items-center gap-2"><input type="checkbox" checked={p.testsConfirmed} onChange={e=>updateProject(pr=>({...pr,testsConfirmed:e.target.checked}))}/> 检测项目已确认</label></div><div className="grid md:grid-cols-2 gap-4"><input className={cls} placeholder="包装源文件路径/文件名（AI/PSD/CDR）" value={p.packageSource} onChange={e=>updateProject(pr=>({...pr,packageSource:e.target.value}))}/><input className={cls} placeholder="包装预览图路径/文件名" value={p.packagePreview} onChange={e=>updateProject(pr=>({...pr,packagePreview:e.target.value}))}/></div><ArrayEditor theme={theme} title="白底图（至少1张，可多角度）" values={p.whiteImages} placeholder="白底图文件名：正面/侧面/45度..." onChange={v=>updateProject(pr=>({...pr,whiteImages:v}))}/></div>;
    if (p.stage === 'mainDetail') return <div className="space-y-5"><input className={cls} placeholder="指定设计师" value={p.designer} onChange={e=>updateProject(pr=>({...pr,designer:e.target.value}))}/><textarea className={cls} rows={4} placeholder="设计自我审核提示词/检查说明" value={p.selfReview} onChange={e=>updateProject(pr=>({...pr,selfReview:e.target.value}))}/><div className="grid lg:grid-cols-2 gap-6"><ArrayEditor theme={theme} title="主图上传" values={p.mainImages} placeholder="主图文件名/路径" onChange={v=>updateProject(pr=>({...pr,mainImages:v}))}/><ArrayEditor theme={theme} title="详情页上传" values={p.detailPages} placeholder="详情页文件名/路径" onChange={v=>updateProject(pr=>({...pr,detailPages:v}))}/></div>{(p.leaderComment || p.opsComment) && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">最新修改意见：{p.opsComment || p.leaderComment}</div>}</div>;
    if (p.stage === 'leaderReview') return <ReviewBlock theme={theme} title="组长审核" comment={p.leaderComment} images={p.leaderImages} setComment={v=>updateProject(pr=>({...pr,leaderComment:v}))} setImages={v=>updateProject(pr=>({...pr,leaderImages:v}))} onReject={()=>reject('leader')} onPass={next}/>;
    if (p.stage === 'opsReview') return <ReviewBlock theme={theme} title="运营审核" comment={p.opsComment} images={p.opsImages} setComment={v=>updateProject(pr=>({...pr,opsComment:v}))} setImages={v=>updateProject(pr=>({...pr,opsImages:v}))} onReject={()=>reject('ops')} onPass={next}/>;
    return <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-6"><Check className="w-8 h-8 text-sky-400 mb-2"/><h3 className="text-xl font-bold">流程已完成</h3><p className={muted}>运营审核通过，新品开发流程结束。</p></div>;
  };

  return <div className="space-y-6">
    <div className="flex items-center justify-between"><div><h2 className={`text-2xl font-bold ${theme==='dark'?'text-white':'text-slate-900'}`}>新品开发</h2><p className={muted}>从立项、卖点、检测、包装、白底图到主图详情审核的流水线原型</p></div><button onClick={createProject} className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"><Plus className="w-4 h-4"/>保存立项为项目</button></div>
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
      <div className="xl:col-span-3 space-y-4"><div className={`p-4 rounded-2xl border ${panel}`}><h3 className="font-bold mb-3">新建立项</h3><div className="space-y-3"><input className={cls} placeholder="产品名称*" value={draft.productName} onChange={e=>setDraft({...draft,productName:e.target.value})}/><input className={cls} placeholder="条码*" value={draft.barcode} onChange={e=>setDraft({...draft,barcode:e.target.value})}/><input className={cls} placeholder="执行标准*" value={draft.standard} onChange={e=>setDraft({...draft,standard:e.target.value})}/></div></div><div className={`p-4 rounded-2xl border ${panel}`}><h3 className="font-bold mb-3">项目列表</h3><div className="space-y-2">{projects.length===0&&<p className={`text-sm ${muted}`}>暂无项目，先保存一个立项。</p>}{projects.map(p=><button key={p.id} onClick={()=>setSelectedId(p.id)} className={`w-full text-left p-3 rounded-xl border transition ${selectedId===p.id?'border-sky-500 bg-sky-500/10':'border-slate-700 hover:border-slate-500'}`}><div className="font-bold truncate">{p.productName}</div><div className="text-xs text-sky-400 mt-1">{stages.find(s=>s.key===p.stage)?.label}</div><div className={`text-xs ${muted}`}>{p.barcode}</div></button>)}</div></div></div>
      <div className="xl:col-span-9 space-y-5">{selected ? <><div className={`p-4 rounded-2xl border ${panel}`}><div className="flex flex-wrap gap-2">{stages.map((s,idx)=><div key={s.key} className={`px-3 py-1 rounded-full text-xs font-bold ${stages.findIndex(x=>x.key===selected.stage)>=idx?'bg-sky-600 text-white':'bg-slate-800 text-slate-500'}`}>{idx+1}. {s.label}</div>)}</div></div><div className={`p-6 rounded-2xl border ${panel}`}>{renderProjectForm(selected)}{!['leaderReview','opsReview','done'].includes(selected.stage)&&<div className="mt-6 flex justify-end"><button onClick={next} className="bg-sky-600 hover:bg-sky-500 text-white px-5 py-2 rounded-lg font-bold flex items-center gap-2"><Send className="w-4 h-4"/>提交到下一步</button></div>}</div><div className={`p-4 rounded-2xl border ${panel}`}><h3 className="font-bold mb-3">流程记录</h3><div className="space-y-2">{selected.history.map((h,i)=><div key={i} className={`text-sm ${muted}`}>#{i+1} {h}</div>)}</div></div></> : <div className={`p-10 rounded-2xl border ${panel} text-center`}><FileText className="w-10 h-10 mx-auto text-slate-500 mb-3"/><p className={muted}>请选择左侧项目，或先创建一个新品立项。</p></div>}</div>
    </div>
  </div>;
}

function ReviewBlock({ theme, title, comment, images, setComment, setImages, onReject, onPass }: { theme:'dark'|'light'; title:string; comment:string; images:string[]; setComment:(v:string)=>void; setImages:(v:string[])=>void; onReject:()=>void; onPass:()=>void }) {
  const cls = theme === 'dark' ? inputCls : lightInputCls;
  return <div className="space-y-5"><h3 className="text-lg font-bold">{title}</h3><textarea className={cls} rows={4} placeholder="如需退回，请填写修改内容；可说明问题点、修改方向、注意事项" value={comment} onChange={e=>setComment(e.target.value)}/><ArrayEditor theme={theme} title="审核标注图片/参考图" values={images} placeholder="图片文件名/路径（可选）" onChange={setImages}/><div className="flex justify-end gap-3"><button onClick={onReject} className="bg-red-600 hover:bg-red-500 text-white px-5 py-2 rounded-lg font-bold flex items-center gap-2"><RotateCcw className="w-4 h-4"/>退回设计修改</button><button onClick={onPass} className="bg-sky-600 hover:bg-sky-500 text-white px-5 py-2 rounded-lg font-bold flex items-center gap-2"><Check className="w-4 h-4"/>审核通过</button></div></div>;
}
