import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Check,
  Clock,
  FileText,
  History,
  Image as ImageIcon,
  PackageOpen,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { User } from './types';

const API_BASE = '/api';

type ManagedUser = { username: string; role: string };
type BrandOption = { id: number; name: string };
type OpsRotation = { usernames: string[]; currentIndex: number; currentUsername: string; weekKey: string };
type StepConfig = {
  stepKey: string;
  stepOrder: number;
  label: string;
  durationHours: number;
  assigneeUsernames: string[];
  assigneePositions: string[];
  escalationHours: number;
  escalationUsernames: string[];
  escalationPositions: string[];
};
type FileRef = { name?: string; path?: string };
type NewDevProject = {
  id: number;
  title: string;
  barcode: string;
  standard: string;
  brand: string;
  spec: string;
  currentStepKey: string;
  dueAt: string | null;
  data: Record<string, any>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  assignees: string[];
};

type HistoryEntry = {
  id?: string;
  at?: string;
  user?: string;
  stepLabel?: string;
  action?: string;
  summary?: string;
};

const dataLabels: Record<string, string> = {
  initiationSellingPoints: '立项卖点',
  sellingPoints: '卖点信息',
  testItems: '需要检测项目',
  feasibleTestItems: '可做检测项目',
  purchaseItems: '采购审核项目',
  purchaseReview: '采购审核说明',
  copywritingConfirm: '文案和检测项目确认',
  packagingSourceFiles: '包装源文件',
  packagingPreviewImages: '包装预览图',
  whiteBackgroundImages: '白底图',
  mainDetailSourceFiles: '主图详情源文件',
  skuImages: 'SKU 图',
  mainImages: '主图',
  detailImages: '详情页',
  leaderReviewComment: '组长审核意见',
  leaderRejectText: '组长退回修改内容',
  leaderRejectImages: '组长退回图片',
  opsReviewComment: '运营审核意见',
  opsRejectText: '运营退回修改内容',
  opsRejectImages: '运营退回图片',
};

const stepOrder = ['initiation', 'selling', 'purchase', 'packaging', 'mainDetail', 'leaderReview', 'opsReview', 'done'];

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRows(value: any): string[] {
  return Array.isArray(value) ? value.map(item => String(item ?? '')) : [];
}

function safePathName(value: string) {
  return String(value || '未命名新品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '未命名新品';
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatRemaining(value?: string | null) {
  if (!value) return '未设置';
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return '未设置';
  if (diff <= 0) return '已超时';
  const hours = Math.floor(diff / 36e5);
  const minutes = Math.max(0, Math.round((diff % 36e5) / 60000));
  return `${hours}小时${minutes}分钟`;
}

function thumbnailUrl(path?: string, token?: string) {
  if (!path) return '';
  const query = `path=${encodeURIComponent(String(path).replace(/\\/g, '/'))}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return `${API_BASE}/thumbnail?${query}`;
}

function downloadUrl(path?: string, token?: string) {
  if (!path) return '';
  const query = `path=${encodeURIComponent(String(path).replace(/\\/g, '/'))}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return `${API_BASE}/download?${query}&inline=1`;
}

function compactHistoryValue(value: any): any {
  if (typeof value === 'string') {
    if (/^data:/i.test(value) || value.length > 200000) return '[large value omitted]';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(compactHistoryValue);
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    Object.entries(value).forEach(([key, item]) => {
      if (key === 'snapshot' || key === 'history') return;
      result[key] = compactHistoryValue(item);
    });
    return result;
  }
  return value;
}

function compactProjectForSave(project: NewDevProject): NewDevProject {
  const data = { ...(project.data || {}) };
  if (Array.isArray(data.history)) {
    data.history = data.history.slice(-80).map((entry: any) => {
      const compact = entry && typeof entry === 'object' ? { ...entry } : {};
      delete compact.snapshot;
      if (Array.isArray(compact.changes)) {
        compact.changes = compact.changes.slice(-30).map((change: any) => ({
          ...change,
          from: compactHistoryValue(change?.from),
          to: compactHistoryValue(change?.to),
        }));
      }
      return compact;
    });
  }
  return { ...project, data };
}

function projectDraftKey(project: NewDevProject) {
  return JSON.stringify(compactProjectForSave(project));
}

function mergeFileLists(...lists: any[][]) {
  const result: FileRef[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const file of Array.isArray(list) ? list : []) {
      const key = String(file?.path || file?.name || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(file);
    }
  }
  return result;
}

function rowKey(prefix: string, index: number, text: string) {
  const clean = String(text || '').trim();
  return clean ? `${prefix}:${clean}` : `${prefix}:row:${index}`;
}

function mapImagesByRows(oldMap: any, oldRows: string[], nextRows: string[]) {
  const oldObj = oldMap && typeof oldMap === 'object' && !Array.isArray(oldMap) ? oldMap : {};
  const next: Record<string, FileRef[]> = {};
  nextRows.forEach((text, index) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    const previousText = String(oldRows[index] || '').trim();
    next[clean] = mergeFileLists(oldObj[clean], previousText && previousText !== clean ? oldObj[previousText] : []);
  });
  return next;
}

function stampEditors(nextRows: string[], oldRows: string[], previous: any, username: string) {
  const source = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const next: Record<string, string> = {};
  nextRows.forEach((row, index) => {
    const text = String(row || '').trim();
    if (!text) return;
    const oldText = String(oldRows[index] || '').trim();
    next[text] = text !== oldText ? username : (source[text] || username);
  });
  return next;
}

function imageGroups(data: Record<string, any>, type: 'selling' | 'test') {
  const rows = normalizeRows(type === 'selling' ? data.sellingPoints : data.testItems);
  const images = type === 'selling' ? data.sellingPointImages : data.testItemImages;
  const authors = type === 'selling' ? data.sellingPointAuthors : data.testItemAuthors;
  const editors = type === 'selling' ? data.sellingPointEditors : data.testItemEditors;
  const imageMap = images && typeof images === 'object' && !Array.isArray(images) ? images : {};
  return rows
    .map(text => String(text || '').trim())
    .filter(Boolean)
    .map(text => ({
      text,
      author: authors?.[text] || '-',
      editor: editors?.[text] || authors?.[text] || '-',
      files: asArray<FileRef>(imageMap[text]),
    }))
    .filter(group => group.files.length || group.text);
}

function buildPackagingConfirm(data: Record<string, any>) {
  const sellingPoints = normalizeRows(data.sellingPoints).filter(Boolean);
  const purchaseItems = asArray<any>(data.purchaseItems);
  const passed = purchaseItems.filter(item => item?.status !== 'fail').map(item => String(item?.name || '').trim()).filter(Boolean);
  const fallbackTests = normalizeRows(data.testItems).filter(Boolean);
  return [
    '卖点信息：',
    sellingPoints.length ? sellingPoints.map((item, index) => `${index + 1}. ${item}`).join('\n') : '无',
    '',
    '确认可做检测项目：',
    (passed.length ? passed : fallbackTests).length ? (passed.length ? passed : fallbackTests).map((item, index) => `${index + 1}. ${item}`).join('\n') : '无',
  ].join('\n');
}

function buildPurchaseSummary(data: Record<string, any>) {
  const original = normalizeRows(data.testItems).map(item => item.trim()).filter(Boolean);
  const items = asArray<any>(data.purchaseItems);
  const passed: string[] = [];
  const failed: string[] = [];
  const details: string[] = [];
  const source = items.length ? items : original.map(name => ({ name, status: 'pending' }));
  source.forEach((item, index) => {
    const name = String(item?.name || '').trim();
    const sourceName = String(item?.sourceName || original[index] || name).trim();
    const detail = String(item?.detail || '').trim();
    const reason = String(item?.reason || '').trim();
    if (!name) return;
    if (item?.status === 'fail') failed.push(`${sourceName}${reason ? `（原因：${reason}）` : ''}`);
    else passed.push(`${sourceName}${detail ? `（具体检测项：${detail}）` : ''}`);
    if (detail && item?.status !== 'fail') details.push(`${sourceName} -> ${detail}`);
  });
  return [
    `通过：${passed.length ? passed.join('、') : '无'}`,
    `未通过：${failed.length ? failed.join('、') : '无'}`,
    details.length ? `补充检测项：${details.join('；')}` : '补充检测项：无',
    data.purchaseReview ? `采购补充说明：${data.purchaseReview}` : '采购补充说明：无',
  ].join('\n');
}

function proposalStatusMap(value: any): Record<string, 'accepted' | 'rejected'> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function appendAcceptedSellingPoint(data: Record<string, any>, point: string, username: string) {
  const clean = String(point || '').trim();
  if (!clean) return data;
  const currentRows = normalizeRows(data.sellingPoints);
  const exists = currentRows.some(row => String(row || '').trim() === clean);
  const nextRows = exists ? currentRows : [...currentRows.filter(row => String(row || '').trim()), clean];
  return {
    ...data,
    sellingPoints: nextRows,
    sellingPointAuthors: { ...(data.sellingPointAuthors || {}), [clean]: (data.sellingPointAuthors || {})[clean] || username },
    sellingPointEditors: { ...(data.sellingPointEditors || {}), [clean]: username },
    purchaseSellingPointStatus: { ...proposalStatusMap(data.purchaseSellingPointStatus), [clean]: 'accepted' },
  };
}

function clipboardImageFiles(data?: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files || []).filter(file => file.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(data.items || [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
}

async function cloneClipboardFiles(files: File[]) {
  const cloned: File[] = [];
  for (const file of files) {
    const ext = file.type.split('/')[1] || 'png';
    const name = file.name && file.name !== 'image.png' ? file.name : `paste-${Date.now()}-${cloned.length + 1}.${ext}`;
    cloned.push(new File([await file.arrayBuffer()], name, { type: file.type || 'image/png' }));
  }
  return cloned;
}

function fieldFolder(field: string, label: string) {
  if (field.startsWith('sellingPointImages:')) return `运营寻找卖点/卖点图片/${safePathName(label)}`;
  if (field.startsWith('testItemImages:')) return `运营寻找卖点/检测项图片/${safePathName(label)}`;
  return dataLabels[field] || field;
}

export default function NewDevelopmentSystem({
  theme,
  user,
  isActive = true,
  openTarget,
  onOpenTargetHandled,
}: {
  theme: 'dark' | 'light';
  user: User;
  isActive?: boolean;
  openTarget?: { projectId: number; stepKey?: string } | null;
  onOpenTargetHandled?: () => void;
}) {
  const [projects, setProjects] = useState<NewDevProject[]>([]);
  const [steps, setSteps] = useState<StepConfig[]>([]);
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [opsRotation, setOpsRotation] = useState<OpsRotation | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [screen, setScreen] = useState<'list' | 'create' | 'detail'>('list');
  const [detailStepKey, setDetailStepKey] = useState<string | null>(null);
  const [notifyOperationsOnPurchase, setNotifyOperationsOnPurchase] = useState(true);
  const [draft, setDraft] = useState({ title: '', barcode: '', standard: '', brand: '', brandId: '', spec: '', purchaseSellingPoints: [''] });
  const autoSaveRef = useRef<number | null>(null);
  const lastAutoSavedKeyRef = useRef<Record<number, string>>({});

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${user.token}`,
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || response.statusText || '请求失败');
    return data;
  }, [user.token]);

  const selected = useMemo(() => projects.find(project => project.id === selectedId) || null, [projects, selectedId]);
  const stepMap = useMemo(() => new Map(steps.map(step => [step.stepKey, step])), [steps]);
  const designers = useMemo(() => users.filter(item => /设计|美工|designer/i.test(item.role || '') || user.permissions?.canManageNewDevelopment), [users, user.permissions]);
  const visibleStepKey = selected ? (detailStepKey || selected.currentStepKey) : null;
  const currentStep = visibleStepKey ? stepMap.get(visibleStepKey) : null;
  const canManage = !!user.permissions?.canManageNewDevelopment || !!user.permissions?.canManageUsers || user.username === '任小雨';
  const canReviewPurchaseSelling = canManage || /运营/.test(user.role || '') || /杩愯惀/.test(user.role || '');
  const viewingCurrentStep = !!selected && (!visibleStepKey || visibleStepKey === selected.currentStepKey);
  const canEditSelected = !!selected && viewingCurrentStep && !selected.completedAt && (canManage || selected.assignees?.includes(user.username) || (['selling', 'opsReview'].includes(selected.currentStepKey) && /运营/.test(user.role || '')));
  const readOnlyReason = selected?.completedAt
    ? '这个新品流程已经完成，只能查看，不能继续编辑。'
    : (!viewingCurrentStep && selected ? '你正在查看历史/其他步骤，只能查看，不能在这里编辑。' : (!canEditSelected && selected ? '你可以查看这个新品流程，但当前步骤不由你处理，不能编辑。' : ''));
  const stepIcons: Record<string, React.ReactNode> = {
    initiation: <span>1</span>,
    selling: <span>2</span>,
    purchase: <span>3</span>,
    packaging: <span>4</span>,
    mainDetail: <span>5</span>,
    leaderReview: <span>6</span>,
    opsReview: <span>7</span>,
    done: <Check className="h-3.5 w-3.5" />,
  };

  const mergeSyncedProjects = useCallback((serverProjects: NewDevProject[]) => {
    setProjects(prev => {
      const prevMap = new Map<number, NewDevProject>(prev.map(item => [item.id, item]));
      return serverProjects.map(server => {
        const local = prevMap.get(server.id);
        if (!local) {
          lastAutoSavedKeyRef.current[server.id] = projectDraftKey(server);
          return server;
        }
        const savedKey = lastAutoSavedKeyRef.current[server.id];
        const localKey = projectDraftKey(local);
        const serverKey = projectDraftKey(server);
        if (localKey === savedKey) {
          lastAutoSavedKeyRef.current[server.id] = serverKey;
          return server;
        }
        if (server.updatedAt !== local.updatedAt) {
          return local;
        }
        return server;
      });
    });
  }, []);

  const refresh = useCallback(async () => {
    const [meta, list] = await Promise.all([api('/newdev/meta'), api('/newdev/projects')]) as [any, NewDevProject[]];
    setSteps(meta.steps || []);
    setBrands(meta.brands || []);
    setUsers(meta.users || []);
    setOpsRotation(meta.opsRotation || null);
    for (const project of (list || []) as NewDevProject[]) {
      lastAutoSavedKeyRef.current[project.id] = projectDraftKey(project);
    }
    setProjects((list || []) as NewDevProject[]);
    setSelectedId(current => current ?? (list?.[0] as NewDevProject | undefined)?.id ?? null);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    refresh().catch(err => {
      setNotice(err.message || '加载新品开发失败');
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(async () => {
      try {
        const state = await api('/newdev/projects/sync-state') as Array<{ id: number; updatedAt: string; currentStepKey: string; completedAt: string | null }>;
        const changed = Array.isArray(state) && state.some(item => {
          const local = projects.find(project => project.id === item.id);
          return !local || local.updatedAt !== item.updatedAt || local.currentStepKey !== item.currentStepKey || local.completedAt !== item.completedAt;
        });
        if (changed || state.length !== projects.length) {
          const list = await api('/newdev/projects') as NewDevProject[];
          mergeSyncedProjects(list || []);
        }
      } catch (err) {
        console.warn('newdev sync failed', err);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [api, isActive, projects]);

  useEffect(() => {
    if (!openTarget?.projectId) return;
    setSelectedId(openTarget.projectId);
    setDetailStepKey(openTarget.stepKey || null);
    setScreen('detail');
    onOpenTargetHandled?.();
  }, [openTarget, onOpenTargetHandled]);

  useEffect(() => {
    if (screen !== 'detail' || !detailStepKey) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-newdev-step="${detailStepKey}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [detailStepKey, screen, selectedId]);

  const updateProjectLocal = useCallback((patch: Partial<NewDevProject>) => {
    if (!selected || !canEditSelected) return;
    setProjects(prev => prev.map(project => project.id === selected.id ? { ...project, ...patch } : project));
  }, [canEditSelected, selected]);

  const saveProject = useCallback(async (project = selected) => {
    if (!project || project.id <= 0) return null;
    if (!canEditSelected) {
      setNotice(readOnlyReason || '当前无权编辑这个流程');
      return null;
    }
    setSaving(true);
    try {
      const saved = await api(`/newdev/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify(compactProjectForSave(project)),
      });
      lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
      setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      setNotice('已保存');
      return saved as NewDevProject;
    } finally {
      setSaving(false);
    }
  }, [api, canEditSelected, readOnlyReason, selected]);

  const scheduleSellingAutosave = useCallback((project: NewDevProject) => {
    if (!canEditSelected) return;
    if (project.currentStepKey !== 'selling' || project.id <= 0) return;
    if (autoSaveRef.current) window.clearTimeout(autoSaveRef.current);
    autoSaveRef.current = window.setTimeout(() => {
      api(`/newdev/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify(compactProjectForSave(project)),
      }).then((saved: NewDevProject) => {
        lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
        setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      }).catch(err => setNotice(err.message || '自动保存失败'));
    }, 450);
  }, [api, canEditSelected]);

  const patchData = useCallback((patch: Record<string, any>) => {
    if (!selected || !canEditSelected) return;
    setProjects(prev => {
      const nextProjects = prev.map(project => {
        if (project.id !== selected.id) return project;
        const next = { ...project, data: { ...(project.data || {}), ...patch } };
        scheduleSellingAutosave(next);
        return next;
      });
      return nextProjects;
    });
  }, [canEditSelected, scheduleSellingAutosave, selected]);

  const decidePurchaseSellingPoint = useCallback(async (point: string, decision: 'accepted' | 'rejected') => {
    if (!selected || selected.id <= 0) return;
    if (autoSaveRef.current) {
      window.clearTimeout(autoSaveRef.current);
      autoSaveRef.current = null;
    }
    setSaving(true);
    try {
      const saved = await api(`/newdev/projects/${selected.id}/purchase-selling-point`, {
        method: 'POST',
        body: JSON.stringify({ point, decision }),
      }) as NewDevProject;
      lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
      setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      setNotice(decision === 'accepted' ? '已采纳并复制到运营卖点' : '已标记不采纳');
    } finally {
      setSaving(false);
    }
  }, [api, selected]);

  const createProject = async () => {
    if (!draft.title.trim()) {
      setNotice('请先填写产品名称');
      return;
    }
    setSaving(true);
    try {
      const brand = brands.find(item => String(item.id) === String(draft.brandId));
      const created = await api('/newdev/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: draft.title,
          barcode: draft.barcode,
          standard: draft.standard,
          brand: brand?.name || draft.brand,
          spec: draft.spec,
          data: {
            brandId: draft.brandId,
            initiationSellingPoints: [''],
            purchaseSellingPoints: normalizeRows(draft.purchaseSellingPoints),
          },
        }),
      });
      setProjects(prev => [created, ...prev.filter(item => item.id !== created.id)]);
      lastAutoSavedKeyRef.current[created.id] = projectDraftKey(created);
      setSelectedId(created.id);
      setScreen('detail');
      setDraft({ title: '', barcode: '', standard: '', brand: '', brandId: '', spec: '', purchaseSellingPoints: [''] });
      setNotice('新品项目已创建');
    } catch (err: any) {
      setNotice(err.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = useCallback(async (field: string, files: FileList | File[] | null) => {
    const fileList = Array.from(files || []).filter(Boolean) as File[];
    if (!selected || !fileList.length) return;
    if (!canEditSelected) {
      setNotice(readOnlyReason || '当前无权上传到这个流程');
      return;
    }
    setUploadingField(field);
    try {
      const cleanField = field.split(':')[0];
      const label = field.split(':').slice(1).join(':') || dataLabels[cleanField] || cleanField;
      const formData = new FormData();
      fileList.forEach((file, index) => formData.append('files', file, file.name || `upload-${Date.now()}-${index + 1}`));
      const folder = fieldFolder(field, label);
      formData.append('path', `${selected.data?.productFolderPath || `新品开发/${safePathName(selected.title)}`}/${folder.split('/').map(safePathName).join('/')}`);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 300000);
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.token}` },
          body: formData,
          signal: controller.signal,
        });
      } catch (err: any) {
        throw new Error(`连接上传服务失败：${err?.message || 'Failed to fetch'}。请确认服务端已启动。`);
      } finally {
        window.clearTimeout(timeout);
      }
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data?.error || '上传失败');
      const uploaded = asArray<FileRef>(data.files);
      let nextData = { ...(selected.data || {}) };
      if (field.startsWith('sellingPointImages:') || field.startsWith('testItemImages:')) {
        const [parent, ...rest] = field.split(':');
        const key = rest.join(':');
        const current = nextData[parent] && typeof nextData[parent] === 'object' ? nextData[parent] : {};
        nextData = {
          ...nextData,
          [parent]: {
            ...current,
            [key]: mergeFileLists(current[key], uploaded).slice(0, 3),
          },
          ...(parent === 'sellingPointImages' ? { sellingPointEditors: { ...(nextData.sellingPointEditors || {}), [key]: user.username } } : {}),
          ...(parent === 'testItemImages' ? { testItemEditors: { ...(nextData.testItemEditors || {}), [key]: user.username } } : {}),
        };
      } else {
        nextData = { ...nextData, [field]: mergeFileLists(nextData[field], uploaded) };
      }
      const nextProject = { ...selected, data: nextData };
      setProjects(prev => prev.map(item => item.id === selected.id ? nextProject : item));
      await saveProject(nextProject);
      setNotice('图片已上传并保存');
    } catch (err: any) {
      setNotice(err.message || '上传失败');
    } finally {
      setUploadingField(null);
    }
  }, [canEditSelected, readOnlyReason, saveProject, selected, user.token, user.username]);

  const deleteUpload = useCallback((field: string, index: number) => {
    if (!selected || !canEditSelected) {
      setNotice(readOnlyReason || '当前无权删除这个流程的文件');
      return;
    }
    let nextData = { ...(selected.data || {}) };
    if (field.startsWith('sellingPointImages:') || field.startsWith('testItemImages:')) {
      const [parent, ...rest] = field.split(':');
      const key = rest.join(':');
      const current = nextData[parent] && typeof nextData[parent] === 'object' ? nextData[parent] : {};
      nextData = { ...nextData, [parent]: { ...current, [key]: asArray(current[key]).filter((_, i) => i !== index) } };
    } else {
      nextData = { ...nextData, [field]: asArray(nextData[field]).filter((_, i) => i !== index) };
    }
    const nextProject = { ...selected, data: nextData };
    setProjects(prev => prev.map(item => item.id === selected.id ? nextProject : item));
    saveProject(nextProject).catch(err => setNotice(err.message || '删除文件失败'));
  }, [canEditSelected, readOnlyReason, saveProject, selected]);

  const advance = async () => {
    if (!selected) return;
    if (!canEditSelected) {
      setNotice(readOnlyReason || '当前无权提交这个流程');
      return;
    }
    setSaving(true);
    try {
      const currentIndex = stepOrder.indexOf(selected.currentStepKey);
      const nextStep = stepOrder[currentIndex + 1] || 'done';
      const projectData = selected.currentStepKey === 'purchase' && !selected.data.copywritingConfirm
        ? { ...(selected.data || {}), copywritingConfirm: buildPackagingConfirm(selected.data || {}) }
        : selected.data;
      const saved = await api(`/newdev/projects/${selected.id}/advance`, {
        method: 'POST',
        body: JSON.stringify({
          stepKey: nextStep,
          data: projectData,
          notifyOperations: selected.currentStepKey === 'purchase' && notifyOperationsOnPurchase,
          purchaseSummary: selected.currentStepKey === 'purchase' ? buildPurchaseSummary(projectData) : '',
        }),
      });
      lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
      setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      setNotice('已提交到下一步');
    } catch (err: any) {
      setNotice(err.message || '提交失败');
    } finally {
      setSaving(false);
    }
  };

  const rejectToDesign = async () => {
    if (!selected) return;
    if (!canEditSelected) {
      setNotice(readOnlyReason || '当前无权退回这个流程');
      return;
    }
    setSaving(true);
    try {
      const saved = await api(`/newdev/projects/${selected.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ targetStepKey: 'mainDetail', data: selected.data }),
      });
      lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
      setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      setNotice('已退回主图详情页设计');
    } catch (err: any) {
      setNotice(err.message || '退回失败');
    } finally {
      setSaving(false);
    }
  };

  const transfer = async (assignee: string) => {
    if (!selected || !assignee) return;
    if (!canEditSelected) {
      setNotice(readOnlyReason || '当前无权转交这个流程');
      return;
    }
    try {
      const saved = await api(`/newdev/projects/${selected.id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({ assignee }),
      });
      lastAutoSavedKeyRef.current[saved.id] = projectDraftKey(saved);
      setProjects(prev => prev.map(item => item.id === saved.id ? saved : item));
      setNotice(`已转交给 ${assignee}`);
    } catch (err: any) {
      setNotice(err.message || '转交失败');
    }
  };

  const removeProject = async () => {
    if (!selected || !window.confirm(`确认删除「${selected.title}」吗？`)) return;
    await api(`/newdev/projects/${selected.id}`, { method: 'DELETE' });
    setProjects(prev => prev.filter(item => item.id !== selected.id));
    setSelectedId(projects.find(item => item.id !== selected.id)?.id || null);
    setNotice('已删除');
  };

  const shell = theme === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900';
  const panel = theme === 'dark' ? 'border-slate-800 bg-slate-900/80' : 'border-slate-200 bg-white';
  const inputClass = theme === 'dark'
    ? 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60'
    : 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60';

  if (loading) {
    return <div className={`flex h-full items-center justify-center ${shell}`}>正在加载新品开发...</div>;
  }

  const listView = (
    <div className="space-y-3">
      <div className={`rounded-lg border p-4 ${panel}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-bold">新品开发</div>
            <div className="text-xs text-slate-500">当前运营：{opsRotation?.currentUsername || '-'}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500" onClick={() => setScreen('create')}>
              <Plus className="h-4 w-4" />
              新建新品
            </button>
            <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" onClick={() => refresh()}>
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <div className="space-y-3">
        {projects.map(project => {
          const stepsForRow = steps.filter(step => step.stepKey !== 'done');
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                setSelectedId(project.id);
                setDetailStepKey(null);
                setScreen('detail');
              }}
              className={`w-full rounded-lg border p-4 text-left transition ${selectedId === project.id && screen === 'detail' ? 'border-sky-500 bg-sky-500/10' : `${theme === 'dark' ? 'border-slate-800 bg-slate-900/70 hover:border-slate-600' : 'border-slate-200 bg-white hover:border-slate-300'}`}`}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">{project.title || '未命名新品'}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stepMap.get(project.currentStepKey)?.label || project.currentStepKey} · {project.completedAt ? '完成' : formatRemaining(project.dueAt)}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-slate-500">负责人：{project.assignees?.join('、') || '-'}</div>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {stepsForRow.map((step, index) => {
                  const active = step.stepKey === project.currentStepKey;
                  const done = stepOrder.indexOf(step.stepKey) < stepOrder.indexOf(project.currentStepKey) || !!project.completedAt;
                  return (
                    <div key={step.stepKey} className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        title={`跳到${step.label}`}
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition ${active ? 'border-sky-400 bg-sky-500 text-white' : done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'border-slate-600 bg-slate-800 text-slate-300 hover:border-slate-400'}`}
                        onClick={event => {
                          event.stopPropagation();
                          setSelectedId(project.id);
                          setDetailStepKey(step.stepKey);
                          setScreen('detail');
                        }}
                      >
                        {stepIcons[step.stepKey] || index + 1}
                      </button>
                      <div className={`min-w-0 text-xs ${active ? 'text-sky-300' : done ? 'text-emerald-300' : 'text-slate-500'}`}>
                        {step.label}
                      </div>
                      {index < stepsForRow.length - 1 && <div className="h-px w-6 shrink-0 bg-slate-700" />}
                    </div>
                  );
                })}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const createView = (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${panel}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-lg font-bold">创建新品</div>
            <div className="text-xs text-slate-500">新建后会进入立项流程，后台字段仍以原逻辑为准</div>
          </div>
          <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" onClick={() => setScreen('list')}>
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className={`rounded-lg border p-4 ${panel}`}>
        <div className="grid gap-2 md:grid-cols-2">
          <input className={inputClass} placeholder="产品名称" value={draft.title} onChange={e => setDraft(v => ({ ...v, title: e.target.value }))} />
          <input className={inputClass} placeholder="条码" value={draft.barcode} onChange={e => setDraft(v => ({ ...v, barcode: e.target.value }))} />
          <input className={inputClass} placeholder="执行标准" value={draft.standard} onChange={e => setDraft(v => ({ ...v, standard: e.target.value }))} />
          <select className={inputClass} value={draft.brandId} onChange={e => {
            const brand = brands.find(item => String(item.id) === e.target.value);
            setDraft(v => ({ ...v, brandId: e.target.value, brand: brand?.name || '' }));
          }}>
            <option value="">请选择品牌</option>
            {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
          <input className={`${inputClass} md:col-span-2`} placeholder="货号" value={draft.spec} onChange={e => setDraft(v => ({ ...v, spec: e.target.value }))} />
        </div>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <LineList
            label="采购添加卖点"
            value={draft.purchaseSellingPoints}
            inputClass={inputClass}
            placeholder="填写采购建议卖点"
            onChange={value => setDraft(v => ({ ...v, purchaseSellingPoints: value }))}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold" onClick={() => setScreen('list')}>返回</button>
          <button type="button" disabled={saving} onClick={createProject} className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-60">
            <Plus className="h-4 w-4" />
            创建
          </button>
        </div>
      </div>
    </div>
  );

  const detailView = !selected ? null : (
    <div className="mx-auto max-w-6xl space-y-4">
              <div className={`rounded-lg border p-4 ${panel}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <Clock className="h-4 w-4" />
                      {currentStep?.label || visibleStepKey || selected.currentStepKey} · 剩余 {formatRemaining(selected.dueAt)}
                    </div>
                    <h2 className="mt-1 text-2xl font-bold">{selected.title || '未命名新品'}</h2>
                    <div className="mt-1 text-sm text-slate-500">
                      负责人：{selected.assignees?.join('、') || '-'} · 最后更新：{formatDate(selected.updatedAt)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setShowHistory(true)} className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-bold text-white hover:bg-slate-600">
                      <History className="h-4 w-4" />
                      历史
                    </button>
                    {canManage && (
                      <button type="button" onClick={() => setShowSettings(true)} className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-bold text-white hover:bg-slate-600">
                        <Settings className="h-4 w-4" />
                        设置
                      </button>
                    )}
                    {canManage && (
                      <button type="button" onClick={removeProject} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-500">
                        <Trash2 className="h-4 w-4" />
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className={`rounded-lg border p-3 ${panel}`}>
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {steps.filter(step => step.stepKey !== 'done').map((step, index) => {
                    const active = step.stepKey === selected.currentStepKey;
                    const viewing = step.stepKey === visibleStepKey;
                    const done = stepOrder.indexOf(step.stepKey) < stepOrder.indexOf(selected.currentStepKey) || !!selected.completedAt;
                    return (
                      <div key={step.stepKey} className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          title={`跳到${step.label}`}
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition ${viewing ? 'ring-2 ring-white/50 ' : ''}${active ? 'border-sky-400 bg-sky-500 text-white' : done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'border-slate-600 bg-slate-800 text-slate-300 hover:border-slate-400'}`}
                          onClick={() => setDetailStepKey(step.stepKey)}
                        >
                          {stepIcons[step.stepKey] || index + 1}
                        </button>
                        <div className={`min-w-0 text-xs ${viewing ? 'text-white' : active ? 'text-sky-300' : done ? 'text-emerald-300' : 'text-slate-500'}`}>
                          {step.label}
                        </div>
                        {index < steps.filter(item => item.stepKey !== 'done').length - 1 && <div className="h-px w-6 shrink-0 bg-slate-700" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {notice && (
                <div className={`rounded-lg border px-4 py-3 text-sm ${theme === 'dark' ? 'border-sky-500/30 bg-sky-500/10 text-sky-100' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>
                  {notice}
                </div>
              )}
              {readOnlyReason && (
                <div className={`rounded-lg border px-4 py-3 text-sm font-medium ${theme === 'dark' ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                  {readOnlyReason}
                </div>
              )}

              <ProjectEditor
                project={selected}
                visibleStepKey={visibleStepKey || selected.currentStepKey}
                steps={steps}
                brands={brands}
                designers={designers}
                theme={theme}
                inputClass={inputClass}
                canEdit={canEditSelected}
                uploadingField={uploadingField}
                token={user.token}
                currentUsername={user.username}
                canReviewPurchaseSelling={canReviewPurchaseSelling}
                notifyOperationsOnPurchase={notifyOperationsOnPurchase}
                onNotifyOperationsChange={setNotifyOperationsOnPurchase}
                onProjectPatch={patch => updateProjectLocal(patch)}
                onDataPatch={patchData}
                onPurchaseSellingPointDecision={decidePurchaseSellingPoint}
                onUpload={uploadFiles}
                onDeleteUpload={deleteUpload}
                onTransfer={transfer}
              />

              {canEditSelected ? (
                <div className={`sticky bottom-0 flex flex-wrap justify-end gap-2 border-t py-4 backdrop-blur ${theme === 'dark' ? 'border-slate-800 bg-slate-950/85' : 'border-slate-200 bg-slate-50/85'}`}>
                  <button type="button" disabled={saving} onClick={() => saveProject()} className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-600 disabled:opacity-50">
                    <Save className="h-4 w-4" />
                    {saving ? '保存中...' : '保存'}
                  </button>
                  {['leaderReview', 'opsReview'].includes(selected.currentStepKey) && (
                    <button type="button" disabled={saving} onClick={rejectToDesign} className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:opacity-50">
                      <ArrowLeft className="h-4 w-4" />
                      退回修改
                    </button>
                  )}
                  <button type="button" disabled={saving} onClick={advance} className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50">
                    <Check className="h-4 w-4" />
                    提交下一步
                  </button>
                </div>
              ) : (
                <div className={`sticky bottom-0 border-t py-4 text-right text-sm text-slate-500 backdrop-blur ${theme === 'dark' ? 'border-slate-800 bg-slate-950/85' : 'border-slate-200 bg-slate-50/85'}`}>
                  只读模式
                </div>
              )}
            </div>
  );

  return (
    <div className={`h-full overflow-hidden ${shell}`}>
      <main className="h-full overflow-y-auto p-5">
        {screen === 'create' ? createView : screen === 'detail' ? detailView : listView}
      </main>

      {showHistory && selected && (
        <Modal title="流程历史" onClose={() => setShowHistory(false)}>
          <div className="space-y-3">
            {asArray<HistoryEntry>(selected.data?.history).slice().reverse().map((item, index) => (
              <div key={item.id || index} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-sm">
                <div className="font-bold">{item.summary || item.action || '记录'}</div>
                <div className="mt-1 text-xs text-slate-500">{item.user || '-'} · {item.stepLabel || '-'} · {formatDate(item.at)}</div>
              </div>
            ))}
            {!asArray(selected.data?.history).length && <div className="text-sm text-slate-500">暂无历史记录</div>}
          </div>
        </Modal>
      )}

      {showSettings && (
        <Modal title="新品流程设置" onClose={() => setShowSettings(false)}>
          <SettingsEditor
            steps={steps}
            users={users}
            opsRotation={opsRotation}
            inputClass={inputClass}
            onSave={async (nextSteps, nextOps) => {
              await api('/newdev/steps', { method: 'POST', body: JSON.stringify({ steps: nextSteps }) });
              await api('/newdev/ops-rotation', { method: 'POST', body: JSON.stringify(nextOps) });
              await refresh();
              setShowSettings(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function ProjectEditor({
  project,
  steps,
  brands,
  designers,
  theme,
  inputClass,
  canEdit,
  uploadingField,
  token,
  currentUsername,
  canReviewPurchaseSelling,
  visibleStepKey,
  notifyOperationsOnPurchase,
  onNotifyOperationsChange,
  onProjectPatch,
  onDataPatch,
  onPurchaseSellingPointDecision,
  onUpload,
  onDeleteUpload,
  onTransfer,
}: {
  project: NewDevProject;
  steps: StepConfig[];
  brands: BrandOption[];
  designers: ManagedUser[];
  theme: 'dark' | 'light';
  inputClass: string;
  canEdit: boolean;
  uploadingField: string | null;
  token?: string;
  currentUsername: string;
  canReviewPurchaseSelling: boolean;
  visibleStepKey: string;
  notifyOperationsOnPurchase: boolean;
  onNotifyOperationsChange: (value: boolean) => void;
  onProjectPatch: (patch: Partial<NewDevProject>) => void;
  onDataPatch: (patch: Record<string, any>) => void;
  onPurchaseSellingPointDecision: (point: string, decision: 'accepted' | 'rejected') => void;
  onUpload: (field: string, files: FileList | File[] | null) => void;
  onDeleteUpload: (field: string, index: number) => void;
  onTransfer: (assignee: string) => void;
}) {
  const data = project.data || {};
  const fieldProps = { className: inputClass, disabled: !canEdit };
  const panel = theme === 'dark' ? 'border-slate-800 bg-slate-900/80' : 'border-slate-200 bg-white';

  if (visibleStepKey === 'selling') {
    const sellingRows = normalizeRows(data.sellingPoints);
    const testRows = normalizeRows(data.testItems);
    const purchaseProposalRows = normalizeRows(data.purchaseSellingPoints).map(row => row.trim()).filter(Boolean);
    const purchaseProposalStatus = proposalStatusMap(data.purchaseSellingPointStatus);
    return (
      <Section title="运营寻找卖点/检测项" className={panel}>
        {!!purchaseProposalRows.length && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="mb-3 text-sm font-bold text-amber-200">采购添加卖点</div>
            <div className="space-y-2">
              {purchaseProposalRows.map((point, index) => {
                const status = purchaseProposalStatus[point];
                return (
                  <div key={`${point}-${index}`} className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-slate-950/40 p-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 text-sm text-slate-100">{point}</div>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" disabled={!canReviewPurchaseSelling || status === 'accepted'} onClick={() => onPurchaseSellingPointDecision(point, 'accepted')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                        {status === 'accepted' ? '已采纳' : '采纳复制到卖点'}
                      </button>
                      <button type="button" disabled={!canReviewPurchaseSelling || status === 'rejected'} onClick={() => onPurchaseSellingPointDecision(point, 'rejected')} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-slate-600 disabled:opacity-50">
                        {status === 'rejected' ? '已不采纳' : '不采纳'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          <CollaborativeList
            label="卖点信息"
            tone="selling"
            rows={sellingRows}
            authors={data.sellingPointAuthors || {}}
            editors={data.sellingPointEditors || {}}
            imagesByText={data.sellingPointImages || {}}
            imageFieldPrefix="sellingPointImages"
            inputClass={inputClass}
            disabled={!canEdit}
            uploadingField={uploadingField}
            currentUsername={currentUsername}
            editLocks={data.editLocks || {}}
            token={token}
            placeholder="填写一个卖点"
            onRowsChange={nextRows => onDataPatch({
              sellingPoints: nextRows,
              sellingPointImages: mapImagesByRows(data.sellingPointImages, sellingRows, nextRows),
              sellingPointEditors: stampEditors(nextRows, sellingRows, data.sellingPointEditors, currentUsername),
            })}
            onLockChange={(key, locked) => onDataPatch({
              editLocks: { ...(data.editLocks || {}), [key]: locked ? { username: currentUsername, at: Date.now() } : undefined },
            })}
            onUpload={onUpload}
            onDeleteUpload={onDeleteUpload}
          />
          <CollaborativeList
            label="需要检测项目"
            tone="test"
            rows={testRows}
            authors={data.testItemAuthors || {}}
            editors={data.testItemEditors || {}}
            imagesByText={data.testItemImages || {}}
            imageFieldPrefix="testItemImages"
            inputClass={inputClass}
            disabled={!canEdit}
            uploadingField={uploadingField}
            currentUsername={currentUsername}
            editLocks={data.editLocks || {}}
            token={token}
            placeholder="填写一个检测项目"
            onRowsChange={nextRows => onDataPatch({
              testItems: nextRows,
              testItemImages: mapImagesByRows(data.testItemImages, testRows, nextRows),
              testItemEditors: stampEditors(nextRows, testRows, data.testItemEditors, currentUsername),
            })}
            onLockChange={(key, locked) => onDataPatch({
              editLocks: { ...(data.editLocks || {}), [key]: locked ? { username: currentUsername, at: Date.now() } : undefined },
            })}
            onUpload={onUpload}
            onDeleteUpload={onDeleteUpload}
          />
        </div>
        <CollaborativeList
          label="参考链接"
          tone="reference"
          rows={normalizeRows(data.referenceLinks)}
          authors={{}}
          editors={{}}
          imagesByText={{}}
          imageFieldPrefix="referenceLinks"
          inputClass={inputClass}
          disabled={!canEdit}
          uploadingField={uploadingField}
          currentUsername={currentUsername}
          editLocks={data.editLocks || {}}
          token={token}
          placeholder="粘贴参考链接"
          showImages={false}
          onRowsChange={nextRows => onDataPatch({ referenceLinks: nextRows })}
          onLockChange={(key, locked) => onDataPatch({
            editLocks: { ...(data.editLocks || {}), [key]: locked ? { username: currentUsername, at: Date.now() } : undefined },
          })}
          onUpload={onUpload}
          onDeleteUpload={onDeleteUpload}
        />
      </Section>
    );
  }

  if (visibleStepKey === 'purchase') {
    const items = asArray<any>(data.purchaseItems).length
      ? asArray<any>(data.purchaseItems)
      : normalizeRows(data.testItems).filter(name => name.trim()).map(name => ({ sourceName: name, name, status: 'pending', detail: '', reason: '' }));
    return (
      <Section title="采购审核检测项" className={panel}>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-400">
          <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={notifyOperationsOnPurchase} onChange={e => onNotifyOperationsChange(e.target.checked)} />
          采购完成后通知运营部门
        </label>
        <PurchaseItems items={items} inputClass={inputClass} disabled={!canEdit} onChange={next => onDataPatch({ purchaseItems: next })} />
        <TextArea label="采购补充说明" value={data.purchaseReview || ''} onChange={value => onDataPatch({ purchaseReview: value })} {...fieldProps} />
      </Section>
    );
  }

  if (visibleStepKey === 'packaging') {
    return (
      <Section title="包装设计 / 白底图" className={panel}>
        <DesignerTransfer designers={designers} disabled={!canEdit} inputClass={inputClass} onTransfer={onTransfer} current={data.transferredTo} />
        <TextArea label="文案和检测项目确认" value={data.copywritingConfirm || buildPackagingConfirm(data)} onChange={value => onDataPatch({ copywritingConfirm: value })} {...fieldProps} />
        <ImageReview title="卖点图片" groups={imageGroups(data, 'selling')} token={token} />
        <ImageReview title="检测项图片" groups={imageGroups(data, 'test')} token={token} />
        <FileUploader label="包装源文件" field="packagingSourceFiles" files={asArray(data.packagingSourceFiles)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
        <FileUploader label="包装预览图" field="packagingPreviewImages" files={asArray(data.packagingPreviewImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
        <FileUploader label="白底图" field="whiteBackgroundImages" files={asArray(data.whiteBackgroundImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
      </Section>
    );
  }

  if (visibleStepKey === 'mainDetail') {
    return (
      <Section title="主图详情页设计" className={panel}>
        <DesignerTransfer designers={designers} disabled={!canEdit} inputClass={inputClass} onTransfer={onTransfer} current={data.transferredTo} />
        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <div className="mb-3 text-sm font-bold">卖点与检测总览</div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ImageReview title="卖点补充图片" groups={imageGroups(data, 'selling')} token={token} />
            <ImageReview title="检测项补充图片" groups={imageGroups(data, 'test')} token={token} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <div className="mb-2 text-xs font-bold text-slate-400">卖点</div>
              <div className="space-y-2 text-sm">
                {normalizeRows(data.sellingPoints).filter(Boolean).map((text, index) => (
                  <div key={`${text}-${index}`} className="rounded bg-slate-900/80 px-3 py-2">{index + 1}. {text}</div>
                ))}
                {!normalizeRows(data.sellingPoints).filter(Boolean).length && <div className="text-xs text-slate-500">暂无卖点</div>}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <div className="mb-2 text-xs font-bold text-slate-400">检测项</div>
              <div className="space-y-2 text-sm">
                {normalizeRows(data.testItems).filter(Boolean).map((text, index) => (
                  <div key={`${text}-${index}`} className="rounded bg-slate-900/80 px-3 py-2">{index + 1}. {text}</div>
                ))}
                {!normalizeRows(data.testItems).filter(Boolean).length && <div className="text-xs text-slate-500">暂无检测项</div>}
              </div>
            </div>
          </div>
        </div>
        {(data.leaderRejectText || data.opsRejectText || asArray(data.leaderRejectImages).length || asArray(data.opsRejectImages).length) && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <div className="mb-2 font-bold text-amber-300">退回意见</div>
            {data.leaderRejectText && <p>组长退回：{data.leaderRejectText}</p>}
            {data.opsRejectText && <p className="mt-1">运营退回：{data.opsRejectText}</p>}
          </div>
        )}
        <FileUploader label="主图详情源文件" field="mainDetailSourceFiles" files={asArray(data.mainDetailSourceFiles)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
        <FileUploader label="SKU 图" field="skuImages" files={asArray(data.skuImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
        <FileUploader label="主图" field="mainImages" files={asArray(data.mainImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
        <FileUploader label="详情页" hint="详情页内容请上传整套页面文件或截图" field="detailImages" files={asArray(data.detailImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
      </Section>
    );
  }

  if (visibleStepKey === 'leaderReview') {
    return (
      <Section title="组长审核" className={panel}>
        <ReviewUploads data={data} token={token} />
        <ImageReview title="卖点补充图片" groups={imageGroups(data, 'selling')} token={token} />
        <ImageReview title="检测项补充图片" groups={imageGroups(data, 'test')} token={token} />
        <TextArea label="审核意见" value={data.leaderReviewComment || ''} onChange={value => onDataPatch({ leaderReviewComment: value })} {...fieldProps} />
        <TextArea label="退回修改内容" value={data.leaderRejectText || ''} onChange={value => onDataPatch({ leaderRejectText: value })} {...fieldProps} />
        <FileUploader label="退回参考图片" field="leaderRejectImages" files={asArray(data.leaderRejectImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
      </Section>
    );
  }

  if (visibleStepKey === 'opsReview') {
    return (
      <Section title="运营审核" className={panel}>
        <ReviewUploads data={data} token={token} />
        <ImageReview title="卖点补充图片" groups={imageGroups(data, 'selling')} token={token} />
        <ImageReview title="检测项补充图片" groups={imageGroups(data, 'test')} token={token} />
        <TextArea label="审核意见" value={data.opsReviewComment || ''} onChange={value => onDataPatch({ opsReviewComment: value })} {...fieldProps} />
        <TextArea label="退回修改内容" value={data.opsRejectText || ''} onChange={value => onDataPatch({ opsRejectText: value })} {...fieldProps} />
        <FileUploader label="退回参考图片" field="opsRejectImages" files={asArray(data.opsRejectImages)} canEdit={canEdit} uploadingField={uploadingField} token={token} onUpload={onUpload} onDelete={onDeleteUpload} />
      </Section>
    );
  }

  if (visibleStepKey === 'done') {
    return (
      <Section title="新品开发已完成" className={panel}>
        <ReviewUploads data={data} token={token} />
        <ImageReview title="卖点补充图片" groups={imageGroups(data, 'selling')} token={token} />
        <ImageReview title="检测项补充图片" groups={imageGroups(data, 'test')} token={token} />
      </Section>
    );
  }

  return (
    <Section title={steps.find(step => step.stepKey === project.currentStepKey)?.label || '立项信息'} className={panel}>
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="产品名称" value={project.title} onChange={value => onProjectPatch({ title: value })} {...fieldProps} />
        <Input label="条码" value={project.barcode} onChange={value => onProjectPatch({ barcode: value })} {...fieldProps} />
        <Input label="执行标准" value={project.standard} onChange={value => onProjectPatch({ standard: value })} {...fieldProps} />
        <label className="block text-sm font-semibold">
          品牌
          <select className={`${inputClass} mt-2`} disabled={!canEdit} value={data.brandId || ''} onChange={event => {
            const brand = brands.find(item => String(item.id) === String(event.target.value));
            onDataPatch({ brandId: event.target.value });
            onProjectPatch({ brand: brand?.name || '' });
          }}>
            <option value="">请选择品牌</option>
            {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </label>
        <Input label="货号" value={project.spec} onChange={value => onProjectPatch({ spec: value })} {...fieldProps} />
      </div>
      <LineList label="立项卖点参考" value={asArray<string>(data.initiationSellingPoints)} inputClass={inputClass} disabled={!canEdit} placeholder="填写立项参考卖点" onChange={value => onDataPatch({ initiationSellingPoints: value })} />
    </Section>
  );
}

function CollaborativeList({
  label,
  tone,
  rows,
  authors,
  editors,
  imagesByText,
  imageFieldPrefix,
  inputClass,
  disabled,
  uploadingField,
  currentUsername,
  editLocks,
  token,
  placeholder,
  showImages = true,
  onRowsChange,
  onLockChange,
  onUpload,
  onDeleteUpload,
}: {
  label: string;
  tone: 'selling' | 'test' | 'reference';
  rows: string[];
  authors: Record<string, string>;
  editors: Record<string, string>;
  imagesByText: Record<string, FileRef[]>;
  imageFieldPrefix: string;
  inputClass: string;
  disabled?: boolean;
  uploadingField: string | null;
  currentUsername: string;
  editLocks: Record<string, { username?: string; at?: number } | undefined>;
  token?: string;
  placeholder?: string;
  showImages?: boolean;
  onRowsChange: (rows: string[]) => void;
  onLockChange: (key: string, locked: boolean) => void;
  onUpload: (field: string, files: FileList | File[] | null) => void;
  onDeleteUpload: (field: string, index: number) => void;
}) {
  const color = tone === 'selling'
    ? {
        shell: 'border-sky-500/35 bg-sky-500/10',
        row: 'border-sky-500/20 bg-sky-950/30',
        button: 'bg-sky-600 hover:bg-sky-500',
        upload: 'border-sky-700 bg-sky-950/50 hover:border-sky-400',
        active: 'border-sky-300 bg-sky-500/15 ring-2 ring-sky-300/40',
        text: 'text-sky-200',
      }
    : tone === 'test' ? {
        shell: 'border-violet-500/35 bg-violet-500/10',
        row: 'border-violet-500/20 bg-violet-950/30',
        button: 'bg-violet-600 hover:bg-violet-500',
        upload: 'border-violet-700 bg-violet-950/50 hover:border-violet-400',
        active: 'border-violet-300 bg-violet-500/15 ring-2 ring-violet-300/40',
        text: 'text-violet-200',
      }
    : {
        shell: 'border-emerald-500/35 bg-emerald-500/10',
        row: 'border-emerald-500/20 bg-emerald-950/30',
        button: 'bg-emerald-600 hover:bg-emerald-500',
        upload: 'border-emerald-700 bg-emerald-950/50 hover:border-emerald-400',
        active: 'border-emerald-300 bg-emerald-500/15 ring-2 ring-emerald-300/40',
        text: 'text-emerald-200',
      };
  const valueRows = rows.length ? rows : [''];
  const [dragField, setDragField] = useState<string | null>(null);
  const hoverRef = useRef<{ field: string; remaining: number } | null>(null);

  useEffect(() => {
    if (disabled) return;
    const handlePaste = async (event: ClipboardEvent) => {
      const target = hoverRef.current;
      if (!target?.field || target.remaining <= 0) return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      onUpload(target.field, await cloneClipboardFiles(files.slice(0, target.remaining)));
    };
    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [disabled, onUpload]);

  const update = (index: number, value: string) => {
    onRowsChange(valueRows.map((row, i) => i === index ? value : row));
  };

  const remove = (index: number) => {
    onRowsChange(valueRows.filter((_, i) => i !== index));
  };

  const addRow = () => {
    const nextRows = [...valueRows, ''];
    onRowsChange(nextRows);
    window.setTimeout(() => onLockChange(rowKey(imageFieldPrefix, nextRows.length - 1, ''), true), 0);
  };

  return (
    <div className={`rounded-lg border p-4 ${color.shell}`}>
      <div className={`mb-3 text-sm font-bold ${color.text}`}>{label}</div>
      <div className="space-y-3">
        {valueRows.map((text, index) => {
          const clean = String(text || '').trim();
          const key = rowKey(imageFieldPrefix, index, clean);
          const blankKey = rowKey(imageFieldPrefix, index, '');
          const lock = editLocks?.[key] || editLocks?.[blankKey];
          const lockedByOther = !!lock?.username && lock.username !== currentUsername && Date.now() - Number(lock.at || 0) < 120000;
          const field = `${imageFieldPrefix}:${clean}`;
          const files = clean ? asArray<FileRef>(imagesByText?.[clean]) : [];
          const remaining = Math.max(0, 3 - files.length);
          return (
            <div key={`${imageFieldPrefix}-row-${index}`} className={`rounded-lg border p-3 ${color.row}`}>
              <div className={`grid gap-3 ${showImages ? 'lg:grid-cols-[1fr_220px]' : ''}`}>
                <div>
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      disabled={disabled || lockedByOther}
                      value={text}
                      placeholder={lockedByOther ? `${lock?.username} 正在编辑这一行` : placeholder}
                      onFocus={() => onLockChange(key, true)}
                      onBlur={() => onLockChange(key, false)}
                      onChange={event => update(index, event.target.value)}
                    />
                    {!disabled && !lockedByOther && (
                      <button type="button" title="删除这一行" onClick={() => remove(index)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white hover:bg-red-500">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {showImages && clean ? `添加人：${authors?.[clean] || '-'} · 最后编辑：${editors?.[clean] || authors?.[clean] || '-'}` : lockedByOther ? `${lock?.username} 新建了空白行，正在编辑` : '空白行会立即同步给其他人'}
                  </div>
                </div>
                {showImages && <div>
                  <div className="mb-1 text-xs font-bold text-slate-400">补充图片 {files.length}/3</div>
                  {!disabled && !lockedByOther && (
                    <label
                      data-newdev-upload={field}
                      onMouseEnter={() => { if (clean) hoverRef.current = { field, remaining }; }}
                      onMouseLeave={() => { if (hoverRef.current?.field === field) hoverRef.current = null; }}
                      onDragEnter={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragField(field);
                        (window as any).__newdevUploadDragActive = true;
                      }}
                      onDragOver={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragField(field);
                        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                      }}
                      onDragLeave={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragField(current => current === field ? null : current);
                        window.setTimeout(() => { (window as any).__newdevUploadDragActive = false; }, 200);
                      }}
                      onDrop={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragField(null);
                        (window as any).__newdevUploadDragActive = false;
                        if (!clean || remaining <= 0) return;
                        onUpload(field, Array.from<File>(event.dataTransfer.files || ({} as FileList)).slice(0, remaining));
                      }}
                      onPaste={async event => {
                        const files = clipboardImageFiles(event.clipboardData);
                        if (!files.length || !clean || remaining <= 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onUpload(field, await cloneClipboardFiles(files.slice(0, remaining)));
                      }}
                      tabIndex={0}
                      className={`flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-3 text-center transition ${dragField === field ? color.active : color.upload} ${(!clean || remaining <= 0) ? 'cursor-not-allowed opacity-60' : ''}`}
                    >
                      <Upload className="h-5 w-5" />
                      <div className="mt-1 text-xs font-bold">{uploadingField === field ? '上传中...' : '拖拽 / 粘贴 / 点击上传'}</div>
                      <div className="mt-1 text-[11px] text-slate-500">{clean ? '鼠标移动到框内后按 Ctrl+V 粘贴图片上传' : '请先填写这一行内容'}</div>
                      <input
                        className="hidden"
                        type="file"
                        accept="image/*"
                        multiple
                        disabled={!clean || remaining <= 0 || uploadingField === field}
                        onClick={event => event.stopPropagation()}
                        onChange={event => {
                          onUpload(field, Array.from<File>(event.target.files || ({} as FileList)).slice(0, remaining));
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  )}
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {files.map((file, fileIndex) => (
                      <div key={`${file.path || file.name}-${fileIndex}`} className="relative aspect-square overflow-hidden rounded border border-slate-800 bg-slate-900">
                        <Thumbnail path={file.path} name={file.name || file.path || ''} token={token} className="h-full w-full object-cover" />
                        {!disabled && (
                          <button type="button" onClick={() => onDeleteUpload(field, fileIndex)} className="absolute right-1 top-1 rounded bg-red-600/90 p-0.5 text-white">
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>}
              </div>
            </div>
          );
        })}
      </div>
      {!disabled && (
        <button type="button" onClick={addRow} className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold text-white ${color.button}`}>
          <Plus className="h-4 w-4" />
          增加一行
        </button>
      )}
    </div>
  );
}

function FileUploader({
  label,
  hint,
  field,
  files,
  canEdit,
  uploadingField,
  token,
  onUpload,
  onDelete,
}: {
  label: string;
  hint?: string;
  field: string;
  files: FileRef[];
  canEdit: boolean;
  uploadingField: string | null;
  token?: string;
  onUpload: (field: string, files: FileList | File[] | null) => void;
  onDelete: (field: string, index: number) => void;
}) {
  const uploading = uploadingField === field;
  const [dragging, setDragging] = useState(false);
  const hovering = useRef(false);

  useEffect(() => {
    if (!canEdit) return;
    const handlePaste = async (event: ClipboardEvent) => {
      if (!hovering.current || uploading) return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      onUpload(field, await cloneClipboardFiles(files));
    };
    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [canEdit, field, onUpload, uploading]);

  return (
    <div className="rounded-lg border border-slate-800 p-4">
      <div className="mb-2 text-sm font-bold">{label}</div>
      {hint && <div className="mb-2 text-xs text-amber-300">{hint}</div>}
      {canEdit && (
        <label
          data-newdev-upload={field}
          onMouseEnter={() => { hovering.current = true; }}
          onMouseLeave={() => { hovering.current = false; }}
          onDragEnter={event => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(true);
            (window as any).__newdevUploadDragActive = true;
          }}
          onDragOver={event => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(true);
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={event => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            window.setTimeout(() => { (window as any).__newdevUploadDragActive = false; }, 200);
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            (window as any).__newdevUploadDragActive = false;
            onUpload(field, event.dataTransfer.files);
          }}
          onPaste={async event => {
            const pasted = clipboardImageFiles(event.clipboardData);
            if (!pasted.length) return;
            event.preventDefault();
            event.stopPropagation();
            onUpload(field, await cloneClipboardFiles(pasted));
          }}
          tabIndex={0}
          className={`flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-5 text-center transition ${dragging ? 'border-sky-300 bg-sky-500/15 ring-2 ring-sky-300/40' : 'border-slate-700 bg-slate-950/60 hover:border-sky-400'}`}
        >
          <Upload className="h-8 w-8 text-sky-400" />
          <div className="mt-2 text-sm font-bold">{uploading ? '上传中...' : '拖拽/粘贴文件到这里，或点击上传'}</div>
          <div className="mt-1 text-xs text-sky-300">鼠标移动到框内后按 Ctrl+V 粘贴图片上传</div>
          <input
            className="hidden"
            type="file"
            multiple
            disabled={uploading}
            onClick={event => event.stopPropagation()}
            onChange={event => {
              onUpload(field, event.target.files);
              event.currentTarget.value = '';
            }}
          />
        </label>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {files.map((file, index) => (
          <FileCard key={`${file.path || file.name}-${index}`} file={file} token={token} canDelete={canEdit} onDelete={() => onDelete(field, index)} />
        ))}
      </div>
      {!files.length && <div className="mt-3 text-xs text-slate-500">暂无上传文件</div>}
    </div>
  );
}

function FileCard({ file, token, canDelete, onDelete }: { key?: React.Key; file: FileRef; token?: string; canDelete?: boolean; onDelete?: () => void }) {
  const name = file.name || file.path || '文件';
  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  const href = downloadUrl(file.path, token);
  return (
    <div className="group relative overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
      <a href={href || undefined} target="_blank" rel="noreferrer" className="block">
        <div className="flex aspect-video items-center justify-center bg-slate-900">
          {isImage ? <Thumbnail path={file.path} token={token} name={name} className="h-full w-full object-contain" /> : <FileText className="h-8 w-8 text-slate-500" />}
        </div>
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-300">
          {isImage ? <ImageIcon className="h-4 w-4 shrink-0 text-sky-400" /> : <FileText className="h-4 w-4 shrink-0 text-slate-400" />}
          <span className="min-w-0 truncate">{name}</span>
        </div>
      </a>
      {canDelete && (
        <button type="button" onClick={onDelete} className="absolute right-2 top-2 rounded bg-red-600/90 p-1 text-white opacity-0 transition group-hover:opacity-100">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Thumbnail({ path, name, token, className }: { path?: string; name?: string; token?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = thumbnailUrl(path, token);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-900">
        <ImageIcon className="h-8 w-8 text-slate-500" />
      </div>
    );
  }
  return <img src={src} alt={name || ''} loading="lazy" decoding="async" onError={() => setFailed(true)} className={className} />;
}

function ImageReview({ title, groups, token }: { title: string; groups: { text: string; author: string; editor: string; files: FileRef[] }[]; token?: string }) {
  if (!groups.length) return null;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <div className="mb-3 text-sm font-bold">{title}</div>
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.text} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-sm font-semibold">{group.text}</div>
            <div className="mt-1 text-xs text-slate-500">添加人：{group.author} · 最后编辑：{group.editor}</div>
            {group.files.length ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.files.map((file, index) => <FileCard key={`${file.path || file.name}-${index}`} file={file} token={token} />)}
              </div>
            ) : (
              <div className="mt-2 text-xs text-slate-500">暂无图片</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewUploads({ data, token }: { data: Record<string, any>; token?: string }) {
  const groups = [
    { label: '主图详情源文件', files: asArray<FileRef>(data.mainDetailSourceFiles) },
    { label: 'SKU 图', files: asArray<FileRef>(data.skuImages) },
    { label: '主图', files: asArray<FileRef>(data.mainImages) },
    { label: '详情页', files: asArray<FileRef>(data.detailImages) },
    { label: '包装源文件', files: asArray<FileRef>(data.packagingSourceFiles) },
    { label: '包装预览图', files: asArray<FileRef>(data.packagingPreviewImages) },
    { label: '白底图', files: asArray<FileRef>(data.whiteBackgroundImages) },
  ];
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <div className="mb-3 text-sm font-bold">已上传内容</div>
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.label}>
            <div className="mb-2 text-xs font-bold text-slate-400">{group.label}</div>
            {group.files.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.files.map((file, index) => <FileCard key={`${file.path || file.name}-${index}`} file={file} token={token} />)}
              </div>
            ) : (
              <div className="text-xs text-slate-600">暂无上传</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PurchaseItems({ items, disabled, inputClass, onChange }: { items: any[]; disabled?: boolean; inputClass: string; onChange: (items: any[]) => void }) {
  const rows = items.length ? items : [{ sourceName: '', name: '', status: 'pending', detail: '', reason: '' }];
  const patch = (index: number, value: any) => onChange(rows.map((item, i) => i === index ? { ...item, ...value } : item));
  return (
    <div>
      <div className="mb-2 text-sm font-semibold">检测项目审核</div>
      <div className="space-y-3">
        {rows.map((item, index) => (
          <div key={index} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div>
                <div className="mb-1 text-xs font-bold text-slate-400">运营提供的需要检测项目</div>
                <input className={inputClass} disabled value={item.sourceName || item.name || ''} />
              </div>
              <div>
                <div className="mb-1 text-xs font-bold text-slate-400">是否可检测</div>
                <div className="flex gap-2">
                  <button type="button" disabled={disabled} onClick={() => patch(index, { status: 'pass' })} className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold ${item.status === 'pass' ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300'} disabled:opacity-60`} title="可以检测">
                    <Check className="h-4 w-4" />
                  </button>
                  <button type="button" disabled={disabled} onClick={() => patch(index, { status: 'fail' })} className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold ${item.status === 'fail' ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-300'} disabled:opacity-60`} title="不可检测">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-3">
              {item.status === 'fail' ? (
                <>
                  <div className="mb-1 text-xs font-bold text-slate-400">不可检测原因</div>
                  <input className={inputClass} disabled={disabled} value={item.reason || ''} placeholder="填写不能检测的原因" onChange={event => patch(index, { reason: event.target.value })} />
                </>
              ) : (
                <>
                  <div className="mb-1 text-xs font-bold text-slate-400">具体检测项</div>
                  <input className={inputClass} disabled={disabled} value={item.detail || item.name || ''} placeholder="补充具体检测项" onChange={event => patch(index, { detail: event.target.value, name: event.target.value || item.sourceName || item.name })} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DesignerTransfer({ designers, disabled, inputClass, current, onTransfer }: { designers: ManagedUser[]; disabled?: boolean; inputClass: string; current?: string; onTransfer: (name: string) => void }) {
  return (
    <label className="block text-sm font-semibold">
      选择设计人
      <select className={`${inputClass} mt-2`} disabled={disabled} value="" onChange={event => event.target.value && onTransfer(event.target.value)}>
        <option value="">{current ? `当前：${current}` : '选择人员后立即转交'}</option>
        {designers.map(member => <option key={member.username} value={member.username}>{member.username} / {member.role}</option>)}
      </select>
    </label>
  );
}

function LineList({ label, value, inputClass, disabled, placeholder, onChange }: { label: string; value: string[]; inputClass: string; disabled?: boolean; placeholder?: string; onChange: (value: string[]) => void }) {
  const rows = value.length ? value : [''];
  return (
    <div>
      <div className="mb-2 text-sm font-semibold">{label}</div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex gap-2">
            <input className={inputClass} disabled={disabled} value={row || ''} placeholder={placeholder} onChange={event => onChange(rows.map((item, i) => i === index ? event.target.value : item))} />
            {!disabled && (
              <button type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white hover:bg-red-500">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <button type="button" onClick={() => onChange([...rows, ''])} className="mt-2 inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500">
          <Plus className="h-4 w-4" />
          增加一行
        </button>
      )}
    </div>
  );
}

function Input({ label, value, className, disabled, onChange }: { label: string; value: string; className: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-semibold">
      {label}
      <input className={`${className} mt-2`} disabled={disabled} value={value || ''} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

function TextArea({ label, value, className, disabled, onChange }: { label: string; value: string; className: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-semibold">
      {label}
      <textarea className={`${className} mt-2`} rows={5} disabled={disabled} value={value || ''} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

function Section({ title, className, children }: { title: string; className: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border p-5 ${className}`}>
      <h3 className="mb-4 text-lg font-bold">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function SettingsEditor({ steps, users, opsRotation, inputClass, onSave }: { steps: StepConfig[]; users: ManagedUser[]; opsRotation: OpsRotation | null; inputClass: string; onSave: (steps: StepConfig[], ops: { usernames: string[]; currentIndex: number }) => void }) {
  const [localSteps, setLocalSteps] = useState(steps);
  const [opsUsers, setOpsUsers] = useState<string[]>(opsRotation?.usernames || []);
  const [currentIndex, setCurrentIndex] = useState(opsRotation?.currentIndex || 0);
  const updateStep = (index: number, patch: Partial<StepConfig>) => setLocalSteps(value => value.map((step, i) => i === index ? { ...step, ...patch } : step));
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-sm font-bold">运营轮值</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {users.filter(item => /运营/.test(item.role || '')).map(member => (
            <label key={member.username} className="flex items-center gap-2 rounded-lg border border-slate-800 p-2 text-sm">
              <input type="checkbox" checked={opsUsers.includes(member.username)} onChange={event => setOpsUsers(value => event.target.checked ? [...value, member.username] : value.filter(name => name !== member.username))} />
              {member.username}
            </label>
          ))}
        </div>
        <input className={`${inputClass} mt-2`} type="number" min={0} value={currentIndex} onChange={event => setCurrentIndex(Number(event.target.value || 0))} />
      </div>
      <div className="space-y-3">
        {localSteps.map((step, index) => (
          <div key={step.stepKey} className="rounded-lg border border-slate-800 p-3">
            <div className="mb-2 font-bold">{step.label}</div>
            <div className="grid gap-2 md:grid-cols-3">
              <input className={inputClass} type="number" min={0} value={step.durationHours} onChange={event => updateStep(index, { durationHours: Number(event.target.value || 0) })} />
              <input className={inputClass} placeholder="负责人，逗号分隔" value={step.assigneeUsernames.join(',')} onChange={event => updateStep(index, { assigneeUsernames: event.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />
              <input className={inputClass} placeholder="负责人岗位，逗号分隔" value={step.assigneePositions.join(',')} onChange={event => updateStep(index, { assigneePositions: event.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500" onClick={() => onSave(localSteps, { usernames: opsUsers, currentIndex })}>
        <Save className="h-4 w-4" />
        保存设置
      </button>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[86vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-slate-800 bg-slate-900 p-5 text-slate-100 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="text-lg font-bold">{title}</div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
