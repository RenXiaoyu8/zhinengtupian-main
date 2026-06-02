/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { 
  Folder, 
  File as FileIcon, 
  Image as ImageIcon, 
  Download, 
  Trash2, 
  Upload, 
  Bell,
  ChevronRight, 
  ChevronLeft,
  LogOut, 
  Search, 
  Info,
  Grid,
  List as ListIcon,
  Box,
  FileText,
  Loader2,
  RefreshCw,
  Sun,
  Moon,
  Plus,
  FolderPlus,
  Tag,
  Package,
  X,
  Check,
  Zap,
  Filter,
  Eye,
  EyeOff,
  Move,
  FolderOpen,
  Megaphone
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { FileItem, User, Product, Brand, UserPermissions } from './types';
import UserManagementModal from './UserManagementModal';
const appLogo = new URL('../尚品易站云资产logo-01.svg', import.meta.url).href;

const API_BASE = '/api';
const NewDevelopmentSystem = lazy(() => import('./NewDevelopmentSystem'));

const pathJoin = (...parts: string[]) => {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
};

type FolderNode = { name: string; children: FolderNode[] };
type AppNotification = { id: number; title: string; message: string; project_id?: number; kind: string; created_at: string; productFolderPath?: string };
type NotifyUser = { username: string; role: string };
type DownloadToast = {
  id: number;
  filename: string;
  state: 'started' | 'progress' | 'completed' | 'failed' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  completedAt: number | null;
};

const formatDownloadToastText = (state: DownloadToast['state']) => {
  if (state === 'completed') return '下载完成，5 秒后自动关闭';
  if (state === 'failed') return '下载失败';
  if (state === 'interrupted') return '下载已中断';
  return '正在下载';
};

const cloneFolderTree = (nodes: FolderNode[] | undefined | null): FolderNode[] =>
  (nodes && Array.isArray(nodes)) ? nodes.map(n => ({ name: n.name, children: cloneFolderTree(n.children) })) : [];

// 产品文件夹树：支持任意层级
type ProductFolderNode = { name: string; children: ProductFolderNode[] };
const INITIAL_PRODUCT_FOLDERS: ProductFolderNode[] = [
  { name: '产品图片', children: [{ name: '原图', children: [] }, { name: '主图', children: [] }, { name: '详情页', children: [] }] },
  { name: '视频', children: [] },
  { name: '检测报告', children: [] },
];
function cloneProductFolderTree(nodes: ProductFolderNode[]): ProductFolderNode[] {
  return (nodes || []).map(n => ({ name: n.name, children: cloneProductFolderTree(n.children || []) }));
}
function getProductNodeAtPath(roots: ProductFolderNode[], path: number[]): ProductFolderNode | null {
  if (path.length === 0) return null;
  const [i, ...rest] = path;
  const node = roots[i];
  if (!node) return null;
  return rest.length === 0 ? node : getProductNodeAtPath(node.children || [], rest);
}
function setProductFoldersAtPath(roots: ProductFolderNode[], path: number[], replace: ProductFolderNode[]): ProductFolderNode[] {
  if (path.length === 0) return replace;
  const [i, ...rest] = path;
  return roots.map((n, idx) => idx === i ? { ...n, children: rest.length === 0 ? replace : setProductFoldersAtPath(n.children || [], rest, replace) } : n);
}
function removeProductNodeAtPath(roots: ProductFolderNode[], path: number[]): ProductFolderNode[] {
  if (path.length <= 0) return roots;
  if (path.length === 1) return roots.filter((_, i) => i !== path[0]);
  const [i, ...rest] = path;
  const node = roots[i];
  if (!node) return roots;
  return roots.map((n, idx) => idx === i ? { ...n, children: removeProductNodeAtPath(n.children || [], rest) } : n);
}
function addProductChildAtPath(roots: ProductFolderNode[], path: number[], child: ProductFolderNode): ProductFolderNode[] {
  if (path.length === 0) return [...roots, child];
  const [i, ...rest] = path;
  return roots.map((n, idx) => idx === i ? { ...n, children: addProductChildAtPath(n.children || [], rest, child) } : n);
}
function normalizeProductFoldersFromApi(data: any[]): ProductFolderNode[] {
  if (!Array.isArray(data)) return cloneProductFolderTree(INITIAL_PRODUCT_FOLDERS);
  return data.map((f: any) => ({
    name: String(f.name || '').trim() || '未命名',
    children: Array.isArray(f.children) ? normalizeProductFoldersFromApi(f.children) : (Array.isArray(f.subFolders) ? (f.subFolders as string[]).map((s: string) => ({ name: String(s).trim() || '未命名', children: [] })) : []),
  }));
}

const INITIAL_SMART_UPLOAD_FOLDERS: FolderNode[] = [
  { name: '产品图片', children: [{ name: '原图', children: [] }, { name: '主图', children: [] }, { name: '详情页', children: [] }] },
  { name: '视频', children: [] },
  { name: '检测报告', children: [] }
];

function getProductFolderPath(product: Product | null | undefined) {
  if (!product) return '';
  const brandName = (product.brand_name || '未分类品牌').replace(/[/\\:*?"<>|]/g, '_');
  const productFolderName = ((product.official_name || '').trim() || product.sku || '').replace(/[/\\:*?"<>|]/g, '_');
  return pathJoin(brandName, productFolderName);
}

function getNotificationProductPath(notification: AppNotification | undefined) {
  if (notification?.project_id) return '';
  if (notification?.productFolderPath) return notification.productFolderPath;
  const kind = notification?.kind || '';
  if (!kind.startsWith('manual-product-update:')) return '';
  try {
    return decodeURIComponent(kind.slice('manual-product-update:'.length).split(':')[0] || '');
  } catch {
    return '';
  }
}

function getNotificationStepKey(notification: AppNotification | undefined) {
  const kind = notification?.kind || '';
  if (kind.startsWith('step:')) return kind.slice('step:'.length);
  if (kind.startsWith('escalation:')) return kind.slice('escalation:'.length);
  return '';
}

function getNodeAtPath(roots: FolderNode[], path: string[]): FolderNode | null {
  if (path.length === 0) return null;
  let level = roots;
  for (let i = 0; i < path.length; i++) {
    const node = level.find(n => n.name === path[i]);
    if (!node) return null;
    if (i === path.length - 1) return node;
    level = node.children;
  }
  return null;
}

function getChildrenAtPath(roots: FolderNode[], path: string[]): FolderNode[] {
  if (path.length === 0) return roots;
  const node = getNodeAtPath(roots, path);
  return node ? node.children : [];
}

function addChildAtPath(roots: FolderNode[], path: string[], name: string): FolderNode[] {
  const next = cloneFolderTree(roots);
  if (path.length === 0) {
    next.push({ name, children: [] });
    return next;
  }
  let level = next;
  for (let i = 0; i < path.length - 1; i++) {
    const idx = level.findIndex(n => n.name === path[i]);
    if (idx === -1) return roots;
    level = level[idx].children;
  }
  const last = path[path.length - 1];
  const parentIdx = level.findIndex(n => n.name === last);
  if (parentIdx === -1) return roots;
  level[parentIdx].children = [...level[parentIdx].children, { name, children: [] }];
  return next;
}

function removeAtPath(roots: FolderNode[], path: string[]): FolderNode[] {
  if (path.length === 0) return roots;
  const next = cloneFolderTree(roots);
  if (path.length === 1) {
    return next.filter(n => n.name !== path[0]);
  }
  let level = next;
  for (let i = 0; i < path.length - 2; i++) {
    const idx = level.findIndex(n => n.name === path[i]);
    if (idx === -1) return roots;
    level = level[idx].children;
  }
  const parentIdx = level.findIndex(n => n.name === path[path.length - 2]);
  if (parentIdx === -1) return roots;
  level[parentIdx].children = level[parentIdx].children.filter(n => n.name !== path[path.length - 1]);
  return next;
}

/** 兼容 Windows 反斜杠：将路径拆分为各级目录名 */
const pathParts = (p: string) => p.split(/[/\\]/).filter(Boolean);

const getParentPath = (p: string) => pathParts(p).slice(0, -1).join('/');

const getCommonParentPath = (paths: string[]) => {
  if (!paths.length) return ''
  const parentPartsList = paths.map(p => pathParts(getParentPath(p)))
  const first = parentPartsList[0] || []
  const common: string[] = []

  for (let i = 0; i < first.length; i += 1) {
    const currentPart = first[i]
    if (parentPartsList.every(parts => parts[i] === currentPart)) {
      common.push(currentPart)
      continue
    }
    break
  }

  return common.join('/')
}

type NewDevStage =
  | 'initiation'
  | 'sellingPointsAndTests'
  | 'purchaseReview'
  | 'packagingDesign'
  | 'mainDetailDesign'
  | 'leaderReview'
  | 'opsReview'
  | 'completed';

type NewDevProject = {
  id: number;
  status: NewDevStage;
  productName: string;
  barcode: string;
  standard: string;
  sellingPoints: string[];
  testItems: { name: string; feasible: 'pending' | 'yes' | 'no'; note: string }[];
  packagingCopyConfirmed: boolean;
  testItemsConfirmed: boolean;
  packagingSourceFile: string;
  packagingPreviewImage: string;
  whiteImages: string[];
  assignedDesigner: string;
  selfReviewPrompt: string;
  mainImages: string[];
  detailPages: string[];
  leaderReviewComment: string;
  leaderReviewAttachments: string[];
  opsReviewComment: string;
  opsReviewAttachments: string[];
  history: string[];
};

const NEW_DEV_STAGE_LABELS: Record<NewDevStage, string> = {
  initiation: '1. 立项',
  sellingPointsAndTests: '2. 运营卖点&检测项',
  purchaseReview: '3. 采购审核检测项',
  packagingDesign: '4. 包装设计&白底图',
  mainDetailDesign: '5. 主图详情设计',
  leaderReview: '6. 组长审核',
  opsReview: '7. 运营审核',
  completed: '8. 已完成'
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [sellingPoints, setSellingPoints] = useState<Record<string, any>>({});
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [rememberPassword, setRememberPassword] = useState(true);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, path?: string, isDir?: boolean } | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [showProductManager, setShowProductManager] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [appNotifications, setAppNotifications] = useState<AppNotification[]>([]);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [suppressNotificationModal, setSuppressNotificationModal] = useState(false);
  const [notifyUsers, setNotifyUsers] = useState<NotifyUser[]>([]);
  const [imageNotifyProduct, setImageNotifyProduct] = useState<Product | null>(null);
  const [imageNotifyForm, setImageNotifyForm] = useState({ departments: [] as string[], usernames: [] as string[], message: '' });
  const [sendingImageNotify, setSendingImageNotify] = useState(false);
  const [showManualNotify, setShowManualNotify] = useState(false);
  const [manualNotifyForm, setManualNotifyForm] = useState({ departments: [] as string[], usernames: [] as string[], title: '', message: '' });
  const [manualNotifyProductMode, setManualNotifyProductMode] = useState(false);
  const [manualNotifyProductSearch, setManualNotifyProductSearch] = useState('');
  const [manualNotifyProduct, setManualNotifyProduct] = useState<Product | null>(null);
  const [manualNotifyDepartmentView, setManualNotifyDepartmentView] = useState<string | null>(null);
  const [sendingManualNotify, setSendingManualNotify] = useState(false);
  const [downloadToast, setDownloadToast] = useState<DownloadToast | null>(null);
  const [showTaggingModal, setShowTaggingModal] = useState<{ 
    files: { name: string, path: string }[], 
    selectedProductIds: number[],
    selectedVariantIds: number[]
  } | null>(null);
  const [newProductForm, setNewProductForm] = useState({ 
    id: undefined as number | undefined,
    sku: '', 
    official_name: '',
    names: '', 
    brand_id: undefined as number | undefined,
    image_path: '',
    variants: [] as { sku: string, color: string }[],
    folders: cloneProductFolderTree(INITIAL_PRODUCT_FOLDERS)
  });
  const [isEditingProduct, setIsEditingProduct] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<number[]>([]);
  const [newChildFolderName, setNewChildFolderName] = useState('');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [productFolderTemplate, setProductFolderTemplate] = useState<ProductFolderNode[]>(cloneProductFolderTree(INITIAL_PRODUCT_FOLDERS));
  const [showBrandManager, setShowBrandManager] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showSmartUpload, setShowSmartUpload] = useState(false);
  const [smartUploadSuccess, setSmartUploadSuccess] = useState<{ count: number } | null>(null);
  const [smartUploadPendingFiles, setSmartUploadPendingFiles] = useState<File[]>([]);
  const [smartUploadPendingPaths, setSmartUploadPendingPaths] = useState<string[]>([]);
  const [smartUploadProgress, setSmartUploadProgress] = useState<{ productIndex: number; productTotal: number; productName: string } | null>(null);
  const [smartUploadConfig, setSmartUploadConfig] = useState({
    productIds: [] as number[],
    variantId: null as number | null,
    folders: cloneFolderTree(INITIAL_SMART_UPLOAD_FOLDERS) as FolderNode[],
    selectedFolderPath: [] as string[],
    newFolderName: ''
  });
  const [smartUploadDirs, setSmartUploadDirs] = useState<string[]>([]);
  const [smartUploadDirsLoading, setSmartUploadDirsLoading] = useState(false);
  const notificationDepartments = useMemo(
    () => Array.from(new Set(notifyUsers.map(u => u.role || '未分部门').filter(Boolean))),
    [notifyUsers]
  );
  const [activeTab, setActiveTab] = useState<'files' | 'products' | 'brands' | 'newdev'>('files');
  const [newDevOpenTarget, setNewDevOpenTarget] = useState<{ projectId: number; stepKey?: string } | null>(null);
  const activeTabRef = useRef<'files' | 'products' | 'brands' | 'newdev'>('files');
  const [savedSearch, setSavedSearch] = useState<{ q: string; results: FileItem[] | null } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectedPathsRef = useRef<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number>(-1);
  const [boxSelect, setBoxSelect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const breadcrumbScrollRef = useRef<HTMLDivElement>(null);
  const downloadAutoCloseTimerRef = useRef<number | null>(null);

  const clearDownloadAutoCloseTimer = useCallback(() => {
    if (downloadAutoCloseTimerRef.current) {
      window.clearTimeout(downloadAutoCloseTimerRef.current);
      downloadAutoCloseTimerRef.current = null;
    }
  }, []);

  const startDownloadToast = useCallback((filename: string, totalBytes = 0) => {
    clearDownloadAutoCloseTimer();
    setDownloadToast({
      id: Date.now(),
      filename: filename || '正在下载文件',
      state: 'started',
      receivedBytes: 0,
      totalBytes: Math.max(Number(totalBytes || 0), 0),
      completedAt: null,
    });
  }, [clearDownloadAutoCloseTimer]);

  const closeDownloadToast = useCallback(() => {
    clearDownloadAutoCloseTimer();
    setDownloadToast(null);
  }, [clearDownloadAutoCloseTimer]);

  const scheduleDownloadToastClose = useCallback(() => {
    clearDownloadAutoCloseTimer();
    downloadAutoCloseTimerRef.current = window.setTimeout(() => {
      setDownloadToast(current => current?.state === 'completed' ? null : current);
      downloadAutoCloseTimerRef.current = null;
    }, 5000);
  }, [clearDownloadAutoCloseTimer]);
  const isInternalDragRef = useRef(false);
  const internalDragPathsRef = useRef<string[]>([]);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // pointer 事件拖拽移动（完全绕开 drag API，兼容 Electron 注入脚本）
  const customDragDataRef = useRef<{ paths: string[]; label: string; startX: number; startY: number; downloadUrls: string[]; isDirs: boolean[] } | null>(null);
  const customDragGhostRef = useRef<{ x: number; y: number; label: string } | null>(null);
  const [customDragGhost, setCustomDragGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  // pointer 拖拽激活时阻止 OS drag 事件触发智能上传
  const isInternalPointerDragRef = useRef(false);
  // 供 pointer drag useEffect 调用导航（用 ref 避免 stale closure）
  const navigateToRef = useRef<(p: string) => void>(() => {});
  // 供 pointer drag useEffect 读取当前目录（用 ref 避免 stale closure）
  const currentPathRef = useRef<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  activeTabRef.current = activeTab;
  const smartUploadInputRef = useRef<HTMLInputElement>(null);
  const smartUploadPendingFilesRef = useRef<File[]>([]);
  const [taggingSearchQuery, setTaggingSearchQuery] = useState('');
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [smartUploadSearch, setSmartUploadSearch] = useState('');
  const [showSmartSearchResults, setShowSmartSearchResults] = useState(false);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [showAddBrandModal, setShowAddBrandModal] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [productImageFile, setProductImageFile] = useState<File | null>(null);

  const [newDevProjects, setNewDevProjects] = useState<NewDevProject[]>([]);
  const [selectedNewDevId, setSelectedNewDevId] = useState<number | null>(null);
  const [newDevDraft, setNewDevDraft] = useState<NewDevProject>({
    id: Date.now(),
    status: 'initiation',
    productName: '',
    barcode: '',
    standard: '',
    sellingPoints: [''],
    testItems: [{ name: '', feasible: 'pending', note: '' }],
    packagingCopyConfirmed: false,
    testItemsConfirmed: false,
    packagingSourceFile: '',
    packagingPreviewImage: '',
    whiteImages: [''],
    assignedDesigner: '',
    selfReviewPrompt: '',
    mainImages: [''],
    detailPages: [''],
    leaderReviewComment: '',
    leaderReviewAttachments: [''],
    opsReviewComment: '',
    opsReviewAttachments: [''],
    history: ['项目创建']
  });

  // 移动到文件夹 弹窗状态
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [movePaths, setMovePaths] = useState<string[]>([]);        // 待移动的文件路径列表
  const [moveBrowsePath, setMoveBrowsePath] = useState('');         // 弹窗内当前浏览的目录
  const [moveInitialPath, setMoveInitialPath] = useState('');       // 文件原来所在目录（用于高亮"当前位置"）
  const [moveBrowseItems, setMoveBrowseItems] = useState<FileItem[]>([]); // 弹窗内当前目录的子项
  const [moveBrowseLoading, setMoveBrowseLoading] = useState(false);
  const [moveExecuting, setMoveExecuting] = useState(false);

  const buildPermissions = (u: any): UserPermissions => {
    if (u && u.permissions) return u.permissions as UserPermissions;
    const role = (u?.role || 'Viewer').toLowerCase();
    if (role === 'admin' || role === 'editor') {
      return {
        canUpload: true,
        canDownload: true,
        canDelete: true,
        canManageProducts: true,
        canManageBrands: true,
        canTag: true,
        canManageUsers: role === 'admin',
        canManageNewDevelopment: true,
      };
    }
    // Viewer 或未知角色：默认只允许下载查看
    return {
      canUpload: false,
      canDownload: true,
      canDelete: false,
      canManageProducts: false,
      canManageBrands: false,
      canTag: false,
      canManageUsers: false,
      canManageNewDevelopment: false,
    };
  };

  // --- 鉴权逻辑 ---
  useEffect(() => {
    try {
      const saved = localStorage.getItem('vf_user');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.token) {
          const permissions = buildPermissions(parsed);
          setUser({ ...parsed, permissions });
        } else {
          localStorage.removeItem('vf_user');
        }
      }
    } catch {
      localStorage.removeItem('vf_user');
    }
    try {
      const savedLogin = localStorage.getItem('vf_saved_login');
      if (savedLogin) {
        const parsed = JSON.parse(savedLogin);
        if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') {
          setLoginForm({ username: parsed.username, password: parsed.password });
          setRememberPassword(true);
        }
      }
    } catch {
      localStorage.removeItem('vf_saved_login');
    }
    const savedTheme = localStorage.getItem('vf_theme') as 'dark' | 'light';
    if (savedTheme) setTheme(savedTheme);
  }, []);

  useEffect(() => {
    localStorage.setItem('vf_theme', theme);
  }, [theme]);

  const notifyShell = useCallback((count: number) => {
    try {
      (window as any).electron?.setNotificationState?.({ count });
    } catch {
      // 桌面壳不可用时忽略，网页端仍显示全屏通知。
    }
  }, []);

  const fetchAppNotifications = useCallback(async () => {
    if (!user?.token) {
      setAppNotifications([]);
      notifyShell(0);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/notifications`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!res.ok) return;
      const list = await res.json();
      const notifications = Array.isArray(list) ? list : [];
      setAppNotifications(prev => {
        const oldKey = prev.map(n => n.id).join(',');
        const newKey = notifications.map(n => n.id).join(',');
        return oldKey === newKey ? prev : notifications;
      });
      notifyShell(notifications.length);
    } catch {
      // 通知轮询失败不打断主流程。
    }
  }, [user?.token, notifyShell]);

  useEffect(() => {
    fetchAppNotifications();
    if (!user?.token) return;
    const timer = window.setInterval(fetchAppNotifications, 20000);
    return () => window.clearInterval(timer);
  }, [user?.token, fetchAppNotifications]);

  useEffect(() => {
    let timer: number | undefined;
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) {
        setSuppressNotificationModal(true);
        if (timer) window.clearTimeout(timer);
      }
    };
    const onFocusOut = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setSuppressNotificationModal(false), 1200);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.onDownloadProgress) return;
    const unsubscribe = electron.onDownloadProgress((payload: any) => {
      const nextState = payload?.state === 'completed'
        ? 'completed'
        : payload?.state === 'failed'
          ? 'failed'
          : payload?.state === 'interrupted'
            ? 'interrupted'
            : payload?.state === 'started'
              ? 'started'
              : 'progress';
      setDownloadToast({
        id: Number(payload?.id || Date.now()),
        filename: String(payload?.filename || '??????'),
        state: nextState,
        receivedBytes: Number(payload?.receivedBytes || 0),
        totalBytes: Number(payload?.totalBytes || 0),
        completedAt: nextState === 'completed' ? Date.now() : null,
      });
      if (nextState === 'completed') {
        scheduleDownloadToastClose();
      } else if (nextState === 'failed' || nextState === 'interrupted') {
        clearDownloadAutoCloseTimer();
      }
    });
    return () => {
      clearDownloadAutoCloseTimer();
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [clearDownloadAutoCloseTimer, scheduleDownloadToastClose]);

  useEffect(() => {
    if (!downloadToast || downloadToast.state !== 'completed') return;
    const handleAfterAction = () => {
      setDownloadToast(current => current?.state === 'completed' ? null : current);
      clearDownloadAutoCloseTimer();
    };
    const onPointerDown = () => handleAfterAction();
    const onKeyDown = () => handleAfterAction();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [downloadToast, clearDownloadAutoCloseTimer]);

  const markAppNotificationRead = async (id: number, silent = false) => {
    if (!user?.token) return;
    if (!silent) setNotificationLoading(true);
    try {
      await fetch(`${API_BASE}/notifications/${id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
      });
      const next = appNotifications.filter(n => n.id !== id);
      setAppNotifications(next);
      notifyShell(next.length);
    } finally {
      if (!silent) setNotificationLoading(false);
    }
  };

  const markAllAppNotificationsRead = async () => {
    if (!user?.token) return;
    setNotificationLoading(true);
    try {
      for (const notification of appNotifications) {
        await markAppNotificationRead(notification.id, true);
      }
      setAppNotifications([]);
      notifyShell(0);
    } finally {
      setNotificationLoading(false);
    }
  };

  const openNotificationProductFolder = async (notification: AppNotification) => {
    const folderPath = getNotificationProductPath(notification);
    if (!folderPath) return;
    setActiveTab('files');
    setCurrentPath(folderPath);
    fetchFiles(folderPath);
    await markAppNotificationRead(notification.id, true);
  };

  const openNotificationNewDev = async (notification: AppNotification) => {
    if (!notification.project_id) return;
    setNewDevOpenTarget({ projectId: Number(notification.project_id), stepKey: getNotificationStepKey(notification) || undefined });
    setActiveTab('newdev');
    await markAppNotificationRead(notification.id, true);
  };

  // 加载产品默认文件夹模板（从后端 product-folders/template）
  useEffect(() => {
    if (!user || !user.permissions.canManageProducts) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/product-folders/template`, {
          headers: { 'Authorization': `Bearer ${user.token}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length) {
            setProductFolderTemplate(normalizeProductFoldersFromApi(data));
          }
        }
      } catch {
        // 忽略模板加载错误，使用前端默认即可
      }
    })();
  }, [user]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm)
      });
      const data = await res.json();
      if (res.ok) {
        const permissions = buildPermissions(data);
        const normalized: User = { ...data, permissions };
        setUser(normalized);
        localStorage.setItem('vf_user', JSON.stringify(normalized));
        if (rememberPassword) {
          localStorage.setItem('vf_saved_login', JSON.stringify(loginForm));
        } else {
          localStorage.removeItem('vf_saved_login');
        }
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('连接服务器失败');
    }
  };

  const handleEditProduct = (product: Product) => {
    setIsEditingProduct(true);
    setProductImageFile(null);
    setSelectedFolderPath([]);
    setNewProductForm({
      id: product.id,
      sku: product.sku || '',
      official_name: product.official_name || '',
      names: product.names || '',
      brand_id: product.brand_id,
      image_path: product.image_path || '',
      variants: (product.variants || []).map(v => ({
        sku: v.sku || '',
        color: v.color || ''
      })),
      folders: cloneProductFolderTree(productFolderTemplate)
    });
    setShowAddProductModal(true);
  };

  const openImageUpdateNotify = (product: Product) => {
    setImageNotifyProduct(product);
    setImageNotifyForm({ departments: [], usernames: [], message: '' });
    if (!notifyUsers.length) fetchNotificationRecipients();
  };

  const sendImageUpdateNotify = async () => {
    if (!user || !imageNotifyProduct || sendingImageNotify) return;
    if (!imageNotifyForm.departments.length && !imageNotifyForm.usernames.length) {
      alert('请选择要通知的人或部门');
      return;
    }
    setSendingImageNotify(true);
    try {
      const res = await fetch(`${API_BASE}/products/${imageNotifyProduct.id}/image-update-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify(imageNotifyForm)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = [data.error, data.details, typeof data.count === 'number' ? `count=${data.count}` : ''].filter(Boolean).join(' | ');
        throw new Error(detail || `发送通知失败（HTTP ${res.status}）`);
      }
      alert(`已发送给 ${data.count || 0} 人`);
      setImageNotifyProduct(null);
    } catch (err: any) {
      alert(err.message || '发送通知失败');
    } finally {
      setSendingImageNotify(false);
    }
  };

  const openManualNotify = () => {
    setManualNotifyForm({ departments: [], usernames: [], title: '', message: '' });
    setManualNotifyProductMode(false);
    setManualNotifyProductSearch('');
    setManualNotifyProduct(null);
    setManualNotifyDepartmentView(null);
    setSuppressNotificationModal(true);
    setShowManualNotify(true);
    if (!notifyUsers.length) fetchNotificationRecipients();
    if (!products.length) fetchProducts();
  };

  const sendManualNotify = async () => {
    if (!user || sendingManualNotify) return;
    const departments = [...new Set(manualNotifyForm.departments.map(v => String(v || '').trim()).filter(Boolean))];
    const usernames = [...new Set(manualNotifyForm.usernames.map(v => String(v || '').trim()).filter(Boolean))];
    if (!departments.length && !usernames.length) {
      alert('请选择要通知的人或部门');
      return;
    }
    if (!manualNotifyForm.title.trim() && !manualNotifyForm.message.trim()) {
      alert('请填写通知标题或内容');
      return;
    }
    if (manualNotifyProductMode && !manualNotifyProduct) {
      alert('请选择要更新的产品');
      return;
    }
    setSendingManualNotify(true);
    try {
      const payload = {
        ...manualNotifyForm,
        departments,
        usernames,
        productUpdate: manualNotifyProductMode,
        productId: manualNotifyProduct?.id,
        productFolderPath: manualNotifyProductMode ? getProductFolderPath(manualNotifyProduct) : '',
        productName: manualNotifyProduct ? (manualNotifyProduct.official_name || manualNotifyProduct.sku) : '',
      };
      const request = async (path: string) => {
        const res = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user.token}`
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      };
      let attempt = await request('/manual-notification');
      if (attempt.res.status === 404) {
        throw new Error('发送通知失败（HTTP 404）。当前正在运行的后台服务还是旧版本，缺少 /api/manual-notification 接口。请先重启后台服务，再重试。');
      }
      if (!attempt.res.ok) {
        const detail = [attempt.data.error, attempt.data.details, typeof attempt.data.count === 'number' ? `count=${attempt.data.count}` : ''].filter(Boolean).join(' | ');
        throw new Error(detail || `发送通知失败（HTTP ${attempt.res.status}）`);
      }
      alert(`已发送给 ${attempt.data.count || 0} 人`);
      setShowManualNotify(false);
      window.setTimeout(() => setSuppressNotificationModal(false), 200);
    } catch (err: any) {
      alert(err.message || '发送通知失败');
    } finally {
      setSendingManualNotify(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('vf_user');
  };

  const handleAuthExpired = useCallback(() => {
    setFiles([]);
    setSearchResults(null);
    setProducts([]);
    setBrands([]);
    setUser(null);
    localStorage.removeItem('vf_user');
    setError('登录已失效，请重新登录');
  }, []);

  // --- 文件操作 ---
  const fetchFiles = useCallback(async (path: string) => {
    if (!user) return;
    setLoading(true);
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(path)}`, {
        headers: { 'Authorization': `Bearer ${user.token}` },
        signal: ctrl.signal
      });
      clearTimeout(timeout);
      if (res.status === 401) {
        handleAuthExpired();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFiles(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Fetch files failed', err);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [user, handleAuthExpired]);

  const [searchResults, setSearchResults] = useState<FileItem[] | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const fetchSellingPoints = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/selling-points`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.status === 401) {
        handleAuthExpired();
        return;
      }
      const data = await res.json();
      setSellingPoints(data);
    } catch (err) {
      console.error('Fetch selling points failed', err);
    }
  }, [user, handleAuthExpired]);

  const fetchProducts = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/products`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.status === 401) {
        handleAuthExpired();
        return;
      }
      const data = await res.json();
      if (res.ok) setProducts(data);
    } catch (err) {
      console.error('Fetch products failed', err);
    }
  }, [user, handleAuthExpired]);

  const fetchBrands = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/brands`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.status === 401) {
        handleAuthExpired();
        return;
      }
      const data = await res.json();
      if (res.ok) setBrands(data);
    } catch (err) {
      console.error('Fetch brands failed', err);
    }
  }, [user, handleAuthExpired]);

  const fetchNotificationRecipients = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/notification-recipients`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.status === 401) {
        handleAuthExpired();
        return;
      }
      const data = await res.json();
      if (res.ok) setNotifyUsers(data);
    } catch (err) {
      console.error('Fetch notification recipients failed', err);
    }
  }, [user, handleAuthExpired]);

  useEffect(() => {
    if (user) {
      fetchFiles(currentPath);
      fetchSellingPoints();
      fetchProducts();
      fetchBrands();
      fetchNotificationRecipients();
    }
  }, [user, currentPath, fetchFiles, fetchSellingPoints, fetchProducts, fetchBrands, fetchNotificationRecipients]);

  useEffect(() => {
    const next = new Set<string>();
    selectedPathsRef.current = next;
    setSelectedPaths(next);
  }, [currentPath]);

  useEffect(() => {
    const el = breadcrumbScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
    });
  }, [currentPath]);

  // 有搜索词时调用递归搜索 API，直接返回匹配的文件（不含文件夹）
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      {
        const next = new Set<string>();
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
      return;
    }
    const t = setTimeout(async () => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      searchAbortRef.current = new AbortController();
      {
        const next = new Set<string>();
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
      try {
        const res = await fetch(`${API_BASE}/files/search?q=${encodeURIComponent(q)}`, {
          headers: { 'Authorization': `Bearer ${user?.token}` },
          signal: searchAbortRef.current.signal
        });
        if (res.status === 401) {
          handleAuthExpired();
          return;
        }
        const data = await res.json().catch(() => []);
        setSearchResults(Array.isArray(data) ? data : []);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, user?.token, handleAuthExpired]);

  // 无搜索时用当前目录；有搜索时用递归搜索结果（仅文件）
  const filteredFiles = useMemo(() => {
    if (searchQuery.trim()) return searchResults ?? [];
    return files;
  }, [files, searchQuery, searchResults]);

  const handleSelectAll = useCallback(() => {
    setSelectedPaths(prev => {
      const allPaths = new Set(filteredFiles.map(f => f.path));
      const next = prev.size === filteredFiles.length && filteredFiles.length > 0 ? new Set<string>() : allPaths;
      selectedPathsRef.current = next;
      return next;
    });
  }, [filteredFiles]);

  useEffect(() => {
    selectedPathsRef.current = selectedPaths;
  }, [selectedPaths]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTab !== 'files') return;
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSelectAll();
      }
      if (e.key === 'Escape') {
        const next = new Set<string>();
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, handleSelectAll]);

  const boxSelectStart = useRef<{ x: number; y: number } | null>(null);
  const boxSelectRect = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const handleFileListMouseUpRef = useRef<() => void>(() => {});

  const handleFileListMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-file-item]')) return;
    if (e.button !== 0) return;
    boxSelectStart.current = { x: e.clientX, y: e.clientY };
    boxSelectRect.current = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    setBoxSelect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };
  const handleFileListMouseUp = useCallback(() => {
    const rect = boxSelectRect.current;
    if (boxSelectStart.current && rect) {
      const x1 = Math.min(rect.x, rect.x + rect.w);
      const y1 = Math.min(rect.y, rect.y + rect.h);
      const x2 = Math.max(rect.x, rect.x + rect.w);
      const y2 = Math.max(rect.y, rect.y + rect.h);
      const moved = Math.abs(rect.w) > 2 || Math.abs(rect.h) > 2;
      const inBox = moved ? filteredFiles.filter((_, i) => {
        const el = fileListRef.current?.querySelector(`[data-file-index="${i}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
      }) : [];
      if (inBox.length > 0) {
        const next = new Set(inBox.map(f => f.path));
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      } else {
        const next = new Set<string>();
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
    }
    boxSelectStart.current = null;
    boxSelectRect.current = null;
    setBoxSelect(null);
  }, [filteredFiles]);
  handleFileListMouseUpRef.current = handleFileListMouseUp;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!boxSelectStart.current) return;
      const w = e.clientX - boxSelectStart.current.x, h = e.clientY - boxSelectStart.current.y;
      boxSelectRect.current = { ...boxSelectStart.current, w, h };
      setBoxSelect(prev => prev ? { ...prev, w, h } : null);
    };
    const onUp = () => {
      if (boxSelectStart.current) handleFileListMouseUpRef.current();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 记录每个目录路径对应的滚动位置，用于"返回"时恢复
  const scrollHistoryRef = useRef<Map<string, number>>(new Map())
  const mainScrollRef = useRef<HTMLElement | null>(null)

  // 统一目录跳转入口：跳转前保存当前滚动位置
  const navigateTo = useCallback((newPath: string) => {
    if (mainScrollRef.current) {
      scrollHistoryRef.current.set(currentPath, mainScrollRef.current.scrollTop)
    }
    setCurrentPath(newPath)
  }, [currentPath])
  navigateToRef.current = navigateTo
  currentPathRef.current = currentPath

  // 加载完毕后恢复目标目录的滚动位置（首次进入则回到顶部）
  useEffect(() => {
    if (loading) return
    const el = mainScrollRef.current
    if (!el) return
    const saved = scrollHistoryRef.current.get(currentPath)
    requestAnimationFrame(() => {
      el.scrollTop = saved ?? 0
    })
  }, [currentPath, loading])

  const handleFileClick = (file: FileItem, index: number, e: React.MouseEvent) => {
    if (file.isDir) {
      if (e.ctrlKey || e.metaKey) {
        setSelectedPaths(prev => {
          const next = new Set(prev);
          if (next.has(file.path)) next.delete(file.path);
          else next.add(file.path);
          selectedPathsRef.current = next;
          return next;
        });
      } else if (e.shiftKey) {
        const start = Math.min(lastClickedIndex >= 0 ? lastClickedIndex : index, index);
        const end = Math.max(lastClickedIndex >= 0 ? lastClickedIndex : index, index);
        const next = new Set(filteredFiles.slice(start, end + 1).map(f => f.path));
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      } else {
        navigateTo(file.path);
        const next = new Set<string>();
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
    } else {
      if (e.ctrlKey || e.metaKey) {
        setSelectedPaths(prev => {
          const next = new Set(prev);
          if (next.has(file.path)) next.delete(file.path);
          else next.add(file.path);
          selectedPathsRef.current = next;
          return next;
        });
      } else if (e.shiftKey) {
        const start = Math.min(lastClickedIndex >= 0 ? lastClickedIndex : index, index);
        const end = Math.max(lastClickedIndex >= 0 ? lastClickedIndex : index, index);
        const next = new Set(filteredFiles.slice(start, end + 1).map(f => f.path));
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      } else {
        const next = new Set([file.path]);
        selectedPathsRef.current = next;
        setSelectedPaths(next);
      }
      setLastClickedIndex(index);
    }
  };

  const handleFileDoubleClick = (file: FileItem) => {
    if (file.isDir) {
      navigateTo(file.path);
      if (searchQuery.trim()) setSearchQuery('');
    } else {
      handleOpenFile(file);
    }
  };

  const handleDownload = (file: FileItem) => {
    if (!user) return;
    const url = `${window.location.origin}${API_BASE}/download?path=${encodeURIComponent(file.path)}&token=${user.token}`;
    startDownloadToast(file.name || '正在下载文件', Number(file.size || 0));
    const electron = (window as any).electron;
    if (electron?.downloadUrl) {
      electron.downloadUrl(url);
    } else {
      window.open(url, '_blank');
      window.setTimeout(() => {
        setDownloadToast(current => current ? {
          ...current,
          state: 'completed',
          receivedBytes: current.totalBytes || current.receivedBytes,
          completedAt: Date.now(),
        } : current);
        scheduleDownloadToastClose();
      }, 800);
    }
  };

  /** 双击打开：Electron 下用系统默认程序打开；本地无文件时先下载到临时目录再打开 */
  const handleOpenFile = async (file: FileItem) => {
    if (!user) return;
    const electron = (window as any).electron;
    if (electron?.openFile) {
      const downloadUrl = `${window.location.origin}${API_BASE}/download?path=${encodeURIComponent(file.path)}&token=${user.token}`;
      const res = await electron.openFile(file.path, downloadUrl);
      if (!res?.ok) handleDownload(file); // 打开失败则下载
    } else {
      handleDownload(file);
    }
  };

  const handleDelete = async (file: FileItem) => {
    if (!user || !user.permissions.canDelete) return;
    if (!confirm(`确定要删除 ${file.name} 吗？`)) return;

    try {
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(file.path)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) fetchFiles(currentPath);
    } catch (err) {
      alert('删除失败');
    }
  };

  const handleDeleteProduct = async (id: number) => {
    if (!user || !user.permissions.canDelete || !user.permissions.canManageProducts) return;
    if (!confirm('确定要删除该产品吗？')) return;

    try {
      const res = await fetch(`${API_BASE}/products/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) fetchProducts();
    } catch (err) {
      alert('删除产品失败');
    }
  };

  /** 上传同名冲突：弹窗三选一（覆盖 / 重命名 / 取消） */
  const [uploadConflictModal, setUploadConflictModal] = useState<{ conflictCount: number } | null>(null);
  const uploadConflictResolverRef = useRef<((v: 'overwrite' | 'rename' | null) => void) | null>(null);

  const finishUploadConflict = useCallback((choice: 'overwrite' | 'rename' | null) => {
    setUploadConflictModal(null);
    const r = uploadConflictResolverRef.current;
    uploadConflictResolverRef.current = null;
    r?.(choice);
  }, []);

  const waitForUploadConflictChoice = useCallback((conflictCount: number) => {
    return new Promise<'overwrite' | 'rename' | null>((resolve) => {
      uploadConflictResolverRef.current = resolve;
      setUploadConflictModal({ conflictCount });
    });
  }, []);

  useEffect(() => {
    if (!uploadConflictModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishUploadConflict(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [uploadConflictModal, finishUploadConflict]);

  const doUpload = useCallback(async (
    filesToUpload: File[],
    targetPathOverride?: string,
    skipTaggingModal?: boolean,
    skipLoading?: boolean,
    conflictStrategy?: 'overwrite' | 'rename'
  ): Promise<{ path: string; name: string }[] | undefined> => {
    if (!user || !user.permissions.canUpload || !filesToUpload.length) return undefined;
    if (!skipLoading) setLoading(true);
    try {
      let selectedStrategy = conflictStrategy;
      while (true) {
        const formData = new FormData();
        filesToUpload.forEach(f => formData.append('files', f));
        formData.append('path', targetPathOverride ?? currentPath);
        if (selectedStrategy) formData.append('conflictStrategy', selectedStrategy);

        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 300000);
        const res = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${user.token}` },
          body: formData,
          signal: ctrl.signal
        });
        clearTimeout(timeout);
        const data = await res.json().catch(() => ({} as any));

        if (res.ok) {
          fetchFiles(currentPath);
          if (!skipTaggingModal) {
            setShowTaggingModal({ files: data.files, selectedProductIds: [], selectedVariantIds: [] });
          }
          return (data.files as { path: string; name: string }[]) || [];
        }

        if (res.status === 409 && data && data.code === 'FILE_CONFLICT' && !selectedStrategy) {
          const conflictCount = Array.isArray(data.conflicts) ? data.conflicts.length : 1;
          const choice = await waitForUploadConflictChoice(conflictCount);
          if (choice === null) {
            return undefined;
          }
          selectedStrategy = choice;
          continue;
        }

        const errMsg = (data as { error?: string }).error || `上传失败 (${res.status})`;
        if (res.status === 413) throw new Error('文件过大，单文件限制 500MB');
        throw new Error(errMsg);
      }
    } catch (err) {
      let msg = err instanceof Error ? err.message : '上传失败';
      if (msg === 'The operation was aborted.') {
        msg = '上传超时（网络较慢或文件较大，请稍后重试）';
      } else if (
        msg === 'Failed to fetch' ||
        msg.includes('NetworkError') ||
        msg.includes('Load failed')
      ) {
        // 只有在真正的网络错误时才提示“网络连接失败”
        msg = '网络连接失败，请检查能否访问服务器（公网 IP、防火墙、端口映射）';
      } else {
        // 其它情况直接展示真实错误，便于诊断（例如：本机路径上传失败、参数缺失等）
        msg = `上传失败：${msg}`;
      }
      alert(msg);
      return undefined;
    } finally {
      if (!skipLoading) {
        setLoading(false);
        setIsDragging(false);
      }
    }
  }, [user, currentPath, fetchFiles, waitForUploadConflictChoice]);

  // 供主进程注入的拖放脚本调用：收到 OS 拖入的文件后打开智能分类上传（主进程在 did-finish-load 注入脚本，在页面上下文最早注册 dragover/drop）
  useEffect(() => {
    const onFilesDropped = (files: File[]) => {
      if (activeTabRef.current === 'newdev') return;
      if ((window as any).__newdevUploadDragActive) return;
      const u = userRef.current;
      /* #region agent log */
      (function(){ var pl={sessionId:'18dc8e',location:'App.tsx:onFilesDropped',message:'callback invoked',data:{filesLen:files?.length,hasUser:!!u,canUpload:!!u?.permissions?.canUpload},timestamp:Date.now()}; try{ if((window as any).__debugLogToFile) (window as any).__debugLogToFile(pl); }catch(e){} fetch('http://127.0.0.1:7793/ingest/23809eb2-266d-4f27-8bde-c919afed29bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'18dc8e'},body:JSON.stringify(pl)}).catch(()=>{}); })();
      /* #endregion */
      // 程序内部拖拽（包括 pointer 拖拽移动）不应触发智能上传
      if (isInternalDragRef.current || isInternalPointerDragRef.current) {
        isInternalDragRef.current = false;
        return;
      }
      if (!u?.permissions?.canUpload || !files?.length) return;
      setShowSmartUpload(true);
      const list = Array.from(files || []);
      const electron = (window as any).electron;
      // 异步展开：目录交给主进程递归获取真实文件路径（优先用 getPathForFile，Electron 新版本 .path 可能不可用）
      (async () => {
        const allPaths: string[] = [];
        const remainFiles: File[] = [];
        const debugLog = (msg: string, data: Record<string, unknown>) => {
          try {
            (window as any).__debugLogToFile?.({ sessionId: '18dc8e', location: 'App.tsx:onFilesDropped', message: msg, data, timestamp: Date.now() });
          } catch (_) {}
        };
        for (const f of list) {
          const p = (electron?.getPathForFile ? electron.getPathForFile(f) : (f as any).path) as string | undefined;
          const pathStr = typeof p === 'string' && p.length > 0 ? p : undefined;
          debugLog('drop item', { name: f.name, hasPath: !!pathStr, pathLen: pathStr ? pathStr.length : 0 });
          if (pathStr && electron?.getFilesFromDir) {
            const filesInDir: string[] = await electron.getFilesFromDir(pathStr);
            debugLog('getFilesFromDir result', { path: pathStr, expandedCount: filesInDir?.length ?? 0 });
            if (filesInDir && filesInDir.length) {
              allPaths.push(...filesInDir);
            } else {
              allPaths.push(pathStr);
            }
          } else {
            remainFiles.push(f);
          }
        }
        debugLog('expansion done', { allPathsCount: allPaths.length, remainFilesCount: remainFiles.length });
        if (allPaths.length) {
          setSmartUploadPendingPaths(prev => [...new Set([...prev, ...allPaths])]);
        }
        if (remainFiles.length) {
          setSmartUploadPendingFiles(prev => [...prev, ...remainFiles]);
        }
      })();
    };
    /* #region agent log */
    (function(){ var pl={sessionId:'18dc8e',location:'App.tsx:useEffect',message:'__onFilesDropped set',data:{},timestamp:Date.now()}; try{ if((window as any).__debugLogToFile) (window as any).__debugLogToFile(pl); }catch(e){} fetch('http://127.0.0.1:7793/ingest/23809eb2-266d-4f27-8bde-c919afed29bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'18dc8e'},body:JSON.stringify(pl)}).catch(()=>{}); })();
    /* #endregion */
    (window as any).__onFilesDropped = onFilesDropped;
    const electron = (window as any).electron;
    if (electron && electron.setOnOsFilesDropped) {
      electron.setOnOsFilesDropped((paths: string[]) => {
        const u = userRef.current;
        if (activeTabRef.current === 'newdev') return;
        if (isInternalDragRef.current || isInternalPointerDragRef.current) {
          isInternalDragRef.current = false;
          return;
        }
        if (!u?.permissions?.canUpload || !paths?.length) return;
        setShowSmartUpload(true);
        // 与 __onFilesDropped 可能重复：同一次拖放既触发注入脚本又触发 will-navigate，按路径去重
        setSmartUploadPendingPaths(prev => [...new Set([...prev, ...paths])]);
      });
    }
    // 兜底：内部拖拽结束/取消时复位，并通知主进程清理拖拽临时缓存
    const onAnyDragEnd = () => {
      // pointer 拖拽进行中时不重置 isInternalDragRef，防止 OS drag end 提前清除保护标志
      if (!isInternalPointerDragRef.current) {
        isInternalDragRef.current = false;
      }
      try { (window as any).electron?.notifyDragEnd?.(); } catch {}
    };
    window.addEventListener('dragend', onAnyDragEnd, true);
    return () => {
      delete (window as any).__onFilesDropped;
      if (electron && electron.setOnOsFilesDropped) electron.setOnOsFilesDropped(() => {});
      window.removeEventListener('dragend', onAnyDragEnd, true);
    };
  }, []);

  // 监听注入脚本派发的自定义事件，用于拖拽时显示遮罩
  useEffect(() => {
    const onAppDragOver = () => {
      if (activeTabRef.current === 'newdev') return;
      if (!isInternalDragRef.current && !isInternalPointerDragRef.current) setIsDragging(true);
    };
    const onAppDragLeave = () => setIsDragging(false);
    window.addEventListener('app-dragover', onAppDragOver);
    window.addEventListener('app-dragleave', onAppDragLeave);
    return () => {
      window.removeEventListener('app-dragover', onAppDragOver);
      window.removeEventListener('app-dragleave', onAppDragLeave);
    };
  }, []);

  // 非 Electron 环境（如浏览器）仍用 document 监听作为兜底
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (activeTabRef.current === 'newdev') return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-newdev-upload]')) return;
      if (e.dataTransfer) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; }
      if (!isInternalDragRef.current && !isInternalPointerDragRef.current) setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget || !document.body.contains(e.relatedTarget as Node)) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (activeTabRef.current === 'newdev') return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-newdev-upload]')) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (isInternalDragRef.current) { isInternalDragRef.current = false; return; }
      if (!user?.permissions?.canUpload || !e.dataTransfer?.files?.length) return;
      // Electron 下由 index.html 注入脚本统一调用 __onFilesDropped，避免与 body 监听重复处理导致同一文件上传两次
      if ((window as any).electron) return;
      setShowSmartUpload(true);
      const list = Array.from(e.dataTransfer.files);
      const electron = (window as any).electron;
      (async () => {
        const allPaths: string[] = [];
        const remainFiles: File[] = [];
        for (const f of list) {
          const p = (electron?.getPathForFile ? electron.getPathForFile(f) : (f as any).path) as string | undefined;
          const pathStr = typeof p === 'string' && p.length > 0 ? p : undefined;
          if (pathStr && electron?.getFilesFromDir) {
            const filesInDir: string[] = await electron.getFilesFromDir(pathStr);
            if (filesInDir?.length) allPaths.push(...filesInDir);
            else allPaths.push(pathStr);
          } else {
            remainFiles.push(f);
          }
        }
        if (allPaths.length) setSmartUploadPendingPaths(prev => [...prev, ...allPaths]);
        if (remainFiles.length) setSmartUploadPendingFiles(prev => [...prev, ...remainFiles]);
      })();
    };
    document.body.addEventListener('dragover', onDragOver, true);
    document.body.addEventListener('dragleave', onDragLeave, true);
    document.body.addEventListener('drop', onDrop, true);
    return () => {
      document.body.removeEventListener('dragover', onDragOver, true);
      document.body.removeEventListener('dragleave', onDragLeave, true);
      document.body.removeEventListener('drop', onDrop, true);
    };
  }, [user]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent, targetPathOverride?: string, skipTaggingModal?: boolean) => {
    let filesToUpload: File[] = [];
    if ('files' in e.target && e.target.files) {
      filesToUpload = Array.from(e.target.files);
      (e.target as HTMLInputElement).value = ''; // 重置以便再次选择同一文件
    } else if ('dataTransfer' in e && e.dataTransfer?.files) {
      filesToUpload = Array.from(e.dataTransfer.files);
    }
    await doUpload(filesToUpload, targetPathOverride, skipTaggingModal);
  };

  const doSmartUpload = useCallback(async (files: File[], pathsFromOs?: string[]) => {
    setLoading(true);
    setSmartUploadSuccess(null);
    setSmartUploadProgress({ productIndex: 0, productTotal: 1, productName: '…' });
    const cleanup = () => {
      setLoading(false);
      setSmartUploadProgress(null);
    };

    if (!smartUploadConfig.productIds.length) {
      cleanup();
      alert('请先搜索并选择要上传到的产品');
      return;
    }
    const hasFiles = files.length > 0;
    const hasPaths = pathsFromOs && pathsFromOs.length > 0;
    if (!hasFiles && !hasPaths) {
      cleanup();
      alert('请先添加要上传的文件');
      return;
    }

    const selectedProducts = products.filter(p => smartUploadConfig.productIds.includes(p.id));
    if (!selectedProducts.length) {
      cleanup();
      alert('未找到所选产品，请重新选择');
      return;
    }

    const primaryProduct = selectedProducts[0];
    const variant = primaryProduct.variants?.find(v => v.id === smartUploadConfig.variantId);
    const brandName = primaryProduct.brand_name || '未分类品牌';
    const productFolderName = ((primaryProduct.official_name || '').trim() || primaryProduct.sku).replace(/[/\\:*?"<>|]/g, '_');
    let targetPath = pathJoin(brandName, productFolderName);
    if (smartUploadConfig.selectedFolderPath.length > 0) {
      targetPath = pathJoin(targetPath, ...smartUploadConfig.selectedFolderPath);
    }

    setSmartUploadProgress({
      productIndex: 1,
      productTotal: 1,
      productName: primaryProduct.sku || primaryProduct.id.toString()
    });

    const allProductIds = selectedProducts.map(p => p.id);
    const variantIds = smartUploadConfig.productIds.length === 1 && smartUploadConfig.variantId ? [smartUploadConfig.variantId] : [];
    const tagFiles = (filePaths: { path: string }[]) => {
      if (!filePaths.length || !user) return;
      return fetch(`${API_BASE}/files/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
        body: JSON.stringify({ file_paths: filePaths.map(f => f.path), product_ids: allProductIds, variant_ids: variantIds })
      }).then(r => { if (!r.ok) console.warn('打标签失败', r.text()); });
    };

    try {
      let uploaded: { path: string; name: string }[] = [];
      // 如果有来自浏览器的 File 且没有本机路径（例如在应用内部拖拽），走前端 doUpload；
      // 一旦有本机路径（操作系统拖入），完全交给主进程 uploadLocalPaths，避免对“文件夹 File 对象”误用导致网络错误。
      if (hasFiles && !hasPaths) {
        const fileClones = files.map(f => new File([f.slice(0, f.size, f.type)], f.name, { type: f.type }));
        const res = await doUpload(fileClones, targetPath, true, true);
        if (res) uploaded = res;
      }
      if (hasPaths && (window as any).electron?.uploadLocalPaths) {
        const baseUrl = window.location.origin;
        let selectedStrategy: 'overwrite' | 'rename' | undefined;
        while (true) {
          const result = await (window as any).electron.uploadLocalPaths({
            paths: pathsFromOs,
            targetPath,
            baseUrl,
            token: user?.token || '',
            conflictStrategy: selectedStrategy
          });
          if (result?.ok) {
            if (result.files?.length) uploaded = [...uploaded, ...result.files];
            break;
          }
          if (result && result.code === 'FILE_CONFLICT' && !selectedStrategy) {
            const conflictCount = Array.isArray(result.conflicts) ? result.conflicts.length : 1;
            const choice = await waitForUploadConflictChoice(conflictCount);
            if (choice === null) {
              break;
            }
            selectedStrategy = choice;
            continue;
          }
          throw new Error((result && result.error) || '本机路径上传失败');
        }
      }
      await tagFiles(uploaded);
      if (uploaded.length > 0) {
        setSmartUploadSuccess({ count: uploaded.length });
        setSmartUploadConfig(prev => ({ ...prev, productIds: [], variantId: null }));
      }
      setSmartUploadPendingFiles([]);
      setSmartUploadPendingPaths([]);
    } catch (err) {
      console.error('智能上传失败', err);
      alert(err instanceof Error ? err.message : '上传过程出错，请重试');
    } finally {
      setLoading(false);
      setSmartUploadProgress(null);
    }
  }, [smartUploadConfig, products, doUpload, user, waitForUploadConflictChoice]);

  // 仅在弹窗打开时重置；不依赖 fetchProducts，避免其引用变化时重复清空待上传文件
  const prevShowSmartUpload = useRef(false);
  useEffect(() => {
    if (showSmartUpload && !prevShowSmartUpload.current) {
      prevShowSmartUpload.current = true;
      fetchProducts();
      setSmartUploadPendingFiles([]);
      setSmartUploadSuccess(null);
      setSmartUploadProgress(null);
      setSmartUploadConfig(prev => ({
        ...prev,
        folders: cloneFolderTree(INITIAL_SMART_UPLOAD_FOLDERS),
        selectedFolderPath: [],
        newFolderName: ''
      }));
    }
    if (!showSmartUpload) prevShowSmartUpload.current = false;
  }, [showSmartUpload, fetchProducts]);

  useEffect(() => {
    smartUploadPendingFilesRef.current = smartUploadPendingFiles;
  }, [smartUploadPendingFiles]);

  // 智能上传：所选第一个产品对应的实际目录路径（用于按实际目录扫描）
  const smartUploadBasePath = useMemo(() => {
    if (!smartUploadConfig.productIds.length || !products.length) return '';
    const p = products.find(prod => prod.id === smartUploadConfig.productIds[0]);
    if (!p) return '';
    const brandName = (p as any).brand_name || '未分类品牌';
    const productFolderName = (((p as any).official_name || '').trim() || (p.sku || '')).replace(/[/\\:*?"<>|]/g, '_');
    return pathJoin(brandName, productFolderName);
  }, [smartUploadConfig.productIds, products]);

  // 按实际目录扫描：当产品与路径变化时拉取当前层级的子文件夹
  const fetchSmartUploadDirs = useCallback(async () => {
    if (!user || !smartUploadBasePath) {
      setSmartUploadDirs([]);
      return;
    }
    setSmartUploadDirsLoading(true);
    try {
      const pathForApi = smartUploadConfig.selectedFolderPath.length
        ? pathJoin(smartUploadBasePath, ...smartUploadConfig.selectedFolderPath)
        : smartUploadBasePath;
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(pathForApi)}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      const data = await res.json().catch(() => []);
      const dirs = Array.isArray(data) ? data.filter((f: FileItem) => f.isDir).map((f: FileItem) => f.name) : [];
      setSmartUploadDirs(dirs);
    } catch {
      setSmartUploadDirs([]);
    } finally {
      setSmartUploadDirsLoading(false);
    }
  }, [user, smartUploadBasePath, smartUploadConfig.selectedFolderPath]);

  useEffect(() => {
    if (!showSmartUpload || !smartUploadBasePath) {
      setSmartUploadDirs([]);
      return;
    }
    fetchSmartUploadDirs();
  }, [showSmartUpload, smartUploadBasePath, smartUploadConfig.selectedFolderPath, fetchSmartUploadDirs]);

  // 智能上传产品搜索：缓存过滤结果，只显示 5 条候选，避免卡顿
  const smartUploadFilteredProducts = useMemo(() => {
    const list = products || [];
    const query = (smartUploadSearch || '').toLowerCase().trim();
    if (!query) return list.slice(0, 5);
    const q = query;
    return list
      .filter(p => {
        const sku = (p.sku || '').toLowerCase();
        const name = (p.official_name || '').toLowerCase();
        const aliases = (p.names || '').toLowerCase();
        return sku.includes(q) || name.includes(q) || aliases.includes(q);
      })
      .slice(0, 5);
  }, [products, smartUploadSearch]);

  const manualNotifyFilteredProducts = useMemo(() => {
    const query = manualNotifyProductSearch.toLowerCase().trim();
    if (!query) return products.slice(0, 8);
    return products
      .filter(p => {
        const sku = (p.sku || '').toLowerCase();
        const name = (p.official_name || '').toLowerCase();
        const aliases = (p.names || '').toLowerCase();
        const brand = (p.brand_name || '').toLowerCase();
        return sku.includes(query) || name.includes(query) || aliases.includes(query) || brand.includes(query);
      })
      .slice(0, 8);
  }, [products, manualNotifyProductSearch]);

  const manualNotifyVisibleUsers = useMemo(() => {
    if (!manualNotifyDepartmentView) return notifyUsers;
    return notifyUsers.filter(member => (member.role || '未分部门') === manualNotifyDepartmentView);
  }, [notifyUsers, manualNotifyDepartmentView]);

  const handleTagFiles = async () => {
    if (!user || !showTaggingModal) return;
    try {
      const res = await fetch(`${API_BASE}/files/tag`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}` 
        },
        body: JSON.stringify({
          file_paths: showTaggingModal.files.map(f => f.path),
          product_ids: showTaggingModal.selectedProductIds,
          variant_ids: showTaggingModal.selectedVariantIds
        })
      });
      if (res.ok) {
        fetchFiles(currentPath);
        setShowTaggingModal(null);
      }
    } catch (err) {
      alert('打标签失败');
    }
  };

  const handleCreateProduct = async () => {
    if (!user) return;
    if (!newProductForm.sku || !newProductForm.official_name) {
      alert('请填写货号和产品正式名称');
      return;
    }
    const normalizedNames = newProductForm.names.replace(/，/g, ',');
    try {
      let imagePath = newProductForm.image_path || '';
      if (productImageFile) {
        const formData = new FormData();
        formData.append('files', productImageFile);
        formData.append('path', 'product_images');
        const uploadRes = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${user.token}` },
          body: formData
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          imagePath = uploadData.files[0].path;
        }
      }

      const res = await fetch(`${API_BASE}/products`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}` 
        },
        body: JSON.stringify({ ...newProductForm, names: normalizedNames, image_path: imagePath })
      });
      if (res.ok) {
        fetchProducts();
        setNewProductForm({ 
          id: undefined,
          sku: '', 
          official_name: '',
          names: '', 
          brand_id: undefined,
          image_path: '', 
          variants: [],
          folders: cloneProductFolderTree(productFolderTemplate)
        });
        setProductImageFile(null);
        setSelectedFolderPath([]);
        setIsEditingProduct(false);
        setShowAddProductModal(false);
      } else {
        const data = await res.json();
        alert(data.error || '创建产品失败');
      }
    } catch (err) {
      alert('网络错误，创建产品失败');
    }
  };

  const handleSaveFolderTemplate = async () => {
    if (!user || !user.permissions.canManageProducts) return;
    try {
      const res = await fetch(`${API_BASE}/product-folders/template`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}` 
        },
        body: JSON.stringify({ folders: newProductForm.folders })
      });
      if (res.ok) {
        setProductFolderTemplate(newProductForm.folders);
        alert('已保存为默认文件夹模板，之后新建产品将使用该结构');
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '保存默认文件夹模板失败');
      }
    } catch {
      alert('网络错误，保存默认文件夹模板失败');
    }
  };

  const handleCreateBrand = async () => {
    if (!user || !newBrandName) return;
    try {
      const res = await fetch(`${API_BASE}/brands`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}` 
        },
        body: JSON.stringify({ name: newBrandName })
      });
      if (res.ok) {
        fetchBrands();
        setNewBrandName('');
        setShowAddBrandModal(false);
      }
    } catch (err) {
      alert('创建品牌失败');
    }
  };

  const handleDeleteBrand = async (id: number) => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/brands/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) fetchBrands();
      else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err) {
      alert('删除品牌失败');
    }
  };

  const handleCreateFolder = async () => {
    if (!user || !user.permissions.canUpload || !newFolderName) return;
    try {
      const res = await fetch(`${API_BASE}/mkdir`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}` 
        },
        body: JSON.stringify({ path: currentPath, name: newFolderName })
      });
      if (res.ok) {
        fetchFiles(currentPath);
        setShowNewFolderModal(false);
        setNewFolderName('');
      } else {
        const data = await res.json();
        alert(data.error || '创建失败');
      }
    } catch (err) {
      alert('网络错误');
    }
  };

  // --- 右键菜单逻辑 ---
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement | null)?.closest?.('[data-file-item]') as HTMLElement | null;
    const p = el?.getAttribute?.('data-file-path') || undefined;
    let isDir: boolean | undefined = undefined;
    if (p) {
      const f = filteredFiles.find(x => x.path === p);
      isDir = f ? !!f.isDir : undefined;
    }
    setContextMenu({ x: e.clientX, y: e.clientY, path: p, isDir });
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  // 加载移动弹窗内指定目录的子文件夹
  const loadMoveBrowse = useCallback(async (browseDir: string) => {
    if (!user) return
    setMoveBrowseLoading(true)
    try {
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(browseDir)}`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      if (res.ok) {
        const data = await res.json()
        const items: FileItem[] = (data.files ?? data) as FileItem[]
        setMoveBrowseItems(items.filter(f => f.isDir))
      }
    } catch (_) {}
    setMoveBrowseLoading(false)
  }, [user])

  // 打开移动弹窗，pathsToMove 为要移动的文件路径列表
  const openMoveModal = useCallback((pathsToMove: string[]) => {
    if (!pathsToMove.length) return
    const initialBrowsePath = getCommonParentPath(pathsToMove) || currentPath
    setMovePaths(pathsToMove)
    setMoveInitialPath(initialBrowsePath)
    setMoveBrowsePath(initialBrowsePath)
    loadMoveBrowse(initialBrowsePath)
    setShowMoveModal(true)
  }, [currentPath, loadMoveBrowse])

  // 底层移动执行（不依赖弹窗状态，可供拖拽和弹窗共用）
  const doMoveFiles = useCallback(async (paths: string[], destination: string) => {
    if (!user || !paths.length) return
    try {
      const res = await fetch(`${API_BASE}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
        body: JSON.stringify({ paths, destination })
      })
      const data = await res.json()
      if (!res.ok && res.status !== 207) {
        alert(data.error || '移动失败')
        return
      }
      const failed = (data.results as { success: boolean; path: string; error?: string }[])
        ?.filter(r => !r.success) ?? []
      if (failed.length) {
        alert(`${paths.length - failed.length} 项移动成功，${failed.length} 项失败：\n${failed.map(r => r.error || r.path).join('\n')}`)
      }
      const next = new Set<string>()
      selectedPathsRef.current = next
      setSelectedPaths(next)
      fetchFiles(currentPath)
    } catch {
      alert('网络错误，请重试')
    }
  }, [user, currentPath, fetchFiles])

  // pointer 事件实现的内部拖拽移动（绕开 drag API，不受 Electron 注入脚本干扰）
  // 注意：必须在 pointermove 里阻止 dragstart，否则 HTML5 drag 启动后 pointerup 不再触发
  useEffect(() => {
    const THRESHOLD = 6;          // 触发拖拽的移动距离(px)
    const HOVER_NAV_DELAY = 700;  // 悬停面包屑自动导航的等待时间(ms)

    let clearPointerTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverNavTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverNavTarget: string | null = null;

    // 阻止 HTML5 dragstart，避免它接管鼠标导致 pointerup 丢失
    const onDragStart = (e: DragEvent) => {
      if (customDragDataRef.current) e.preventDefault();
    };

    // 触发 OS 桌面拖拽（取消内部拖拽 + 调用 electron.startDrag）
    const triggerOsDrag = (data: NonNullable<typeof customDragDataRef.current>) => {
      customDragDataRef.current = null;
      customDragGhostRef.current = null;
      internalDragPathsRef.current = [];
      if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }
      setCustomDragGhost(null);
      setDragOverPath(null);
      const electron = (window as any).electron;
      if (electron?.startDrag) {
        isInternalDragRef.current = true;
        const firstName = data.paths.length > 1 ? `${data.paths.length} 个文件` : ((data.paths[0] || '').split(/[\\/]/).pop() || '正在下载文件');
        startDownloadToast(firstName, 0);
        electron.startDrag(data.paths, data.downloadUrls, data.isDirs);
      }
      if (clearPointerTimer) clearTimeout(clearPointerTimer);
      clearPointerTimer = setTimeout(() => { isInternalPointerDragRef.current = false; }, 2000);
    };

    // 兜底：mouseleave（不要求 ghost 已显示，只要有移动意图即可）
    const onDocMouseLeave = () => {
      const data = customDragDataRef.current;
      if (!data) return;
      // 至少移动过一点距离才认为是有意拖拽
      if (!customDragGhostRef.current) return;
      triggerOsDrag(data);
    };
    document.documentElement.addEventListener('mouseleave', onDocMouseLeave);

    const cancelDrag = () => {
      customDragDataRef.current = null;
      customDragGhostRef.current = null;
      internalDragPathsRef.current = [];
      if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }
      setCustomDragGhost(null);
      setDragOverPath(null);
      if (clearPointerTimer) clearTimeout(clearPointerTimer);
      clearPointerTimer = setTimeout(() => { isInternalPointerDragRef.current = false; }, 300);
    };

    // 右键 / Escape 取消拖拽
    const onContextMenu = (e: MouseEvent) => {
      if (!customDragDataRef.current) return;
      e.preventDefault();
      cancelDrag();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && customDragDataRef.current) cancelDrag();
    };
    // pointercancel（触控板手势等导致的中断）
    const onPointerCancel = () => {
      if (customDragDataRef.current) cancelDrag();
    };

    const onPointerMove = (e: PointerEvent) => {
      const data = customDragDataRef.current;
      if (!data) return;

      const dx = e.clientX - data.startX;
      const dy = e.clientY - data.startY;
      const dist = Math.hypot(dx, dy);

      // ── 检测鼠标是否已离开窗口 ──────────────────────────────────────
      // Chromium 隐式指针捕获：按住鼠标时 pointermove 会持续触发（即使出窗口外）
      // clientX/Y 超出 [0, innerWidth/Height] 即代表鼠标在窗口外
      const outsideWindow =
        e.clientX < 0 || e.clientX > window.innerWidth ||
        e.clientY < 0 || e.clientY > window.innerHeight;

      if (outsideWindow && dist > THRESHOLD) {
        triggerOsDrag(data);
        return;
      }

      if (!customDragGhostRef.current && dist < THRESHOLD) return;

      isInternalPointerDragRef.current = true;

      const ghost = { x: e.clientX, y: e.clientY, label: data.label };
      customDragGhostRef.current = ghost;
      setCustomDragGhost(ghost);

      // ghost 有 pointer-events:none，取消条有 data-drag-cancel，不会被 ghost 遮住
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const cancelZone = el?.closest('[data-drag-cancel]') as HTMLElement | null;
      const fileItem   = el?.closest('[data-file-path]')   as HTMLElement | null;
      const bcItem     = el?.closest('[data-bc-path]')     as HTMLElement | null;

      if (cancelZone) {
        setDragOverPath('__cancel__');
        if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }
      } else if (fileItem && fileItem.getAttribute('data-is-dir') === 'true') {
        const tp = fileItem.getAttribute('data-file-path') ?? '';
        const invalid = data.paths.some(p => p === tp || tp.startsWith(p + '/'));
        setDragOverPath(invalid ? null : tp);
        if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }
      } else if (bcItem) {
        const tp = bcItem.getAttribute('data-bc-path') ?? '';
        setDragOverPath(`__bc__${tp}`);
        if (hoverNavTarget !== tp) {
          hoverNavTarget = tp;
          if (hoverNavTimer) clearTimeout(hoverNavTimer);
          hoverNavTimer = setTimeout(() => {
            navigateToRef.current(tp);
            hoverNavTimer = null;
            hoverNavTarget = null;
          }, HOVER_NAV_DELAY);
        }
      } else {
        // 检查是否在主内容区空白处（有 data-file-list 的 main 元素）
        const inFileList = !!(el?.closest('[data-file-list]'));
        setDragOverPath(inFileList ? '__filelist__' : null);
        if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const data = customDragDataRef.current;
      const hadGhost = !!customDragGhostRef.current;
      customDragDataRef.current = null;
      customDragGhostRef.current = null;
      internalDragPathsRef.current = [];
      if (hoverNavTimer) { clearTimeout(hoverNavTimer); hoverNavTimer = null; hoverNavTarget = null; }

      if (!hadGhost) {
        if (clearPointerTimer) clearTimeout(clearPointerTimer);
        clearPointerTimer = setTimeout(() => { isInternalPointerDragRef.current = false; }, 300);
        setDragOverPath(null);
        return;
      }

      setCustomDragGhost(null);
      setDragOverPath(null);

      if (clearPointerTimer) clearTimeout(clearPointerTimer);
      clearPointerTimer = setTimeout(() => { isInternalPointerDragRef.current = false; }, 2000);

      if (!data) return;

      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const cancelZone = el?.closest('[data-drag-cancel]') as HTMLElement | null;
      const fileItem   = el?.closest('[data-file-path]')   as HTMLElement | null;
      const bcItem     = el?.closest('[data-bc-path]')     as HTMLElement | null;
      const inFileList = !!(el?.closest('[data-file-list]'));

      if (cancelZone) {
        // 取消，不做任何移动
        return;
      } else if (fileItem && fileItem.getAttribute('data-is-dir') === 'true') {
        const tp = fileItem.getAttribute('data-file-path') ?? '';
        const invalid = data.paths.some(p => p === tp || tp.startsWith(p + '/'));
        if (!invalid) doMoveFiles(data.paths, tp);
      } else if (bcItem) {
        const tp = bcItem.getAttribute('data-bc-path') ?? '';
        doMoveFiles(data.paths, tp);
      } else if (inFileList) {
        // 落在主内容区空白处 → 移动到当前目录
        const targetPath = currentPathRef.current;
        const allAlreadyHere = data.paths.every(p => {
          const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
          return parent === targetPath;
        });
        if (!allAlreadyHere) doMoveFiles(data.paths, targetPath);
      }
    };

    document.addEventListener('dragstart',     onDragStart,    true);
    document.addEventListener('pointermove',   onPointerMove);
    document.addEventListener('pointerup',     onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('contextmenu',   onContextMenu,  true);
    document.addEventListener('keydown',       onKeyDown);
    return () => {
      document.removeEventListener('dragstart',     onDragStart,    true);
      document.removeEventListener('pointermove',   onPointerMove);
      document.removeEventListener('pointerup',     onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('contextmenu',   onContextMenu,  true);
      document.removeEventListener('keydown',       onKeyDown);
      document.documentElement.removeEventListener('mouseleave', onDocMouseLeave);
      if (clearPointerTimer) clearTimeout(clearPointerTimer);
      if (hoverNavTimer)     clearTimeout(hoverNavTimer);
    };
  }, [doMoveFiles]);

  // 执行移动（弹窗版，依赖 movePaths 状态）
  const handleMoveFiles = useCallback(async (destination: string) => {
    if (!user || !movePaths.length) return
    setMoveExecuting(true)
    try {
      await doMoveFiles(movePaths, destination)
      setShowMoveModal(false)
    } finally {
      setMoveExecuting(false)
    }
  }, [user, movePaths, doMoveFiles])

  const currentNewDev = useMemo(
    () => newDevProjects.find(p => p.id === selectedNewDevId) || null,
    [newDevProjects, selectedNewDevId]
  );

  const resetNewDevDraft = () => {
    setNewDevDraft({
      id: Date.now(),
      status: 'initiation',
      productName: '',
      barcode: '',
      standard: '',
      sellingPoints: [''],
      testItems: [{ name: '', feasible: 'pending', note: '' }],
      packagingCopyConfirmed: false,
      testItemsConfirmed: false,
      packagingSourceFile: '',
      packagingPreviewImage: '',
      whiteImages: [''],
      assignedDesigner: '',
      selfReviewPrompt: '',
      mainImages: [''],
      detailPages: [''],
      leaderReviewComment: '',
      leaderReviewAttachments: [''],
      opsReviewComment: '',
      opsReviewAttachments: [''],
      history: ['项目创建']
    });
  };

  const createNewDevProject = () => {
    if (!newDevDraft.productName.trim() || !newDevDraft.barcode.trim() || !newDevDraft.standard.trim()) {
      alert('立项阶段请先填写：产品名称、条码、执行标准');
      return;
    }
    const next = { ...newDevDraft, id: Date.now(), history: [...newDevDraft.history, '立项提交'] };
    setNewDevProjects(prev => [next, ...prev]);
    setSelectedNewDevId(next.id);
    resetNewDevDraft();
  };

  const updateCurrentNewDev = (updater: (project: NewDevProject) => NewDevProject) => {
    if (!selectedNewDevId) return;
    setNewDevProjects(prev => prev.map(p => (p.id === selectedNewDevId ? updater(p) : p)));
  };

  const moveToNextStage = () => {
    if (!currentNewDev) return;
    const stage = currentNewDev.status;

    if (stage === 'sellingPointsAndTests') {
      const okSelling = currentNewDev.sellingPoints.some(v => v.trim());
      const okTests = currentNewDev.testItems.some(v => v.name.trim());
      if (!okSelling || !okTests) {
        alert('请至少填写一条卖点和一条检测项目');
        return;
      }
    }

    if (stage === 'packagingDesign') {
      if (!currentNewDev.packagingCopyConfirmed || !currentNewDev.testItemsConfirmed) {
        alert('请先确认文案和检测项目');
        return;
      }
      if (!currentNewDev.packagingSourceFile.trim() || !currentNewDev.packagingPreviewImage.trim()) {
        alert('请填写包装设计源文件和预览图');
        return;
      }
      if (!currentNewDev.whiteImages.some(v => v.trim())) {
        alert('白底图至少上传1张才能下一步');
        return;
      }
    }

    if (stage === 'mainDetailDesign') {
      if (!currentNewDev.assignedDesigner.trim() || !currentNewDev.selfReviewPrompt.trim()) {
        alert('请填写设计师和自我审核提示词');
        return;
      }
      if (!currentNewDev.mainImages.some(v => v.trim()) || !currentNewDev.detailPages.some(v => v.trim())) {
        alert('请上传主图和详情页后再提交');
        return;
      }
    }

    const nextMap: Partial<Record<NewDevStage, NewDevStage>> = {
      initiation: 'sellingPointsAndTests',
      sellingPointsAndTests: 'purchaseReview',
      purchaseReview: 'packagingDesign',
      packagingDesign: 'mainDetailDesign',
      mainDetailDesign: 'leaderReview',
      leaderReview: 'opsReview',
      opsReview: 'completed'
    };

    const next = nextMap[stage];
    if (!next) return;

    updateCurrentNewDev(p => ({
      ...p,
      status: next,
      history: [...p.history, `流转到：${NEW_DEV_STAGE_LABELS[next]}`]
    }));
  };

  const rejectByLeader = () => {
    if (!currentNewDev) return;
    if (!currentNewDev.leaderReviewComment.trim()) {
      alert('组长退回必须填写修改意见');
      return;
    }
    updateCurrentNewDev(p => ({
      ...p,
      status: 'mainDetailDesign',
      history: [...p.history, `组长退回：${p.leaderReviewComment}`]
    }));
  };

  const rejectByOps = () => {
    if (!currentNewDev) return;
    if (!currentNewDev.opsReviewComment.trim()) {
      alert('运营退回必须填写修改意见');
      return;
    }
    updateCurrentNewDev(p => ({
      ...p,
      status: 'mainDetailDesign',
      history: [...p.history, `运营退回：${p.opsReviewComment}`]
    }));
  };

  const getFileIcon = (file: FileItem) => {
    if (file.isDir) return <Folder className={`w-10 h-10 ${theme === 'dark' ? 'text-amber-400 fill-amber-400' : 'text-amber-500 fill-amber-500'}`} />;
    const ext = file.ext;
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return <ImageIcon className="w-10 h-10 text-blue-400" />;
    if (['.obj', '.fbx', '.glb', '.gltf', '.stl'].includes(ext)) return <Box className="w-10 h-10 text-purple-400" />;
    if (['.psd', '.ai', '.pdf'].includes(ext)) return <FileText className="w-10 h-10 text-red-400" />;
    return <FileIcon className="w-10 h-10 text-slate-400" />;
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 匹配卖点
  const currentFolderSellingPoints = sellingPoints[pathParts(currentPath).pop() || ''] || null;

  if (!user) {
    return (
      <div className={`min-h-screen ${theme === 'dark' ? 'bg-slate-950' : 'bg-slate-50'} flex items-center justify-center p-4 sm:p-6 font-sans transition-colors duration-500`} style={{ minHeight: '100vh', backgroundColor: theme === 'dark' ? '#020617' : '#f8fafc' }}>
        <div 
          className={`${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border p-5 sm:p-8 rounded-2xl w-full max-w-md shadow-2xl`}
          style={{ backgroundColor: theme === 'dark' ? '#0f172a' : '#ffffff' }}
        >
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center">
                <img src={appLogo} alt="尚品易站云资产" className="h-16 w-16 sm:h-20 sm:w-20 object-contain" />
              </div>
            </div>
            <h1 className={`text-2xl sm:text-3xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tight mb-2`} style={{ color: theme === 'dark' ? '#ffffff' : '#0f172a' }}>尚品易站云资产</h1>
            <p className="text-slate-400 text-sm font-medium tracking-wide">PREMIUM ASSET HUB</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">用户名（支持中文）</label>
              <input 
                type="text" 
                className={`w-full ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-900'} border rounded-lg px-4 py-3 focus:ring-2 focus:ring-sky-500 outline-none transition-all`}
                value={loginForm.username}
                onChange={e => setLoginForm({...loginForm, username: e.target.value})}
                placeholder="例如：管理员 / 上传专员 / 只读"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">密码</label>
              <div className="relative">
                <input 
                  type={showLoginPassword ? 'text' : 'password'} 
                  className={`w-full ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-900'} border rounded-lg px-4 py-3 pr-11 focus:ring-2 focus:ring-sky-500 outline-none transition-all`}
                  value={loginForm.password}
                  onChange={e => setLoginForm({...loginForm, password: e.target.value})}
                  placeholder="密码（例如：admin123）"
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword(prev => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-sky-500 transition-colors"
                  title={showLoginPassword ? '隐藏密码' : '显示密码'}
                >
                  {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={e => {
                  const checked = e.target.checked;
                  setRememberPassword(checked);
                  if (!checked) localStorage.removeItem('vf_saved_login');
                }}
                className="w-4 h-4 rounded border-slate-600 accent-sky-500"
              />
              记住密码
            </label>
            {error && <p className="text-red-400 text-xs font-medium">{error}</p>}
            <button 
              type="submit"
              className="w-full bg-sky-600 hover:bg-sky-500 text-white font-bold py-3 rounded-lg shadow-lg shadow-sky-900/20 transition-all active:scale-95"
            >
              进入系统
            </button>
          </form>
          <div className="mt-6 pt-6 border-t border-slate-800 text-center">
            <p className="text-slate-500 text-[10px] uppercase tracking-widest">Secure Internal Access Only</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex-1 min-h-0 flex flex-col w-full ${theme === 'dark' ? 'bg-slate-950 text-slate-200' : 'bg-slate-50 text-slate-700'} font-sans transition-colors duration-500`}
      style={{ backgroundColor: theme === 'dark' ? '#020617' : '#f8fafc', color: theme === 'dark' ? '#e2e8f0' : '#334155' }}
    >
      {/* 根级上传 input，避免被右键菜单卸载导致点击无反应 */}
      <input ref={fileInputRef} type="file" className="hidden" multiple onChange={handleUpload} />
      {appNotifications.length > 0 && !suppressNotificationModal && !showManualNotify && !imageNotifyProduct && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-xl rounded-2xl border p-6 shadow-2xl ${theme === 'dark' ? 'border-amber-400/40 bg-slate-900 text-slate-100' : 'border-amber-300 bg-white text-slate-900'}`}>
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-400 text-slate-950">
                <Info className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-amber-400">新品开发通知</div>
                <h3 className="mt-1 text-xl font-bold">{appNotifications[0].title}</h3>
                <p className={`mt-3 text-sm leading-6 ${theme === 'dark' ? 'text-slate-300' : 'text-slate-600'}`}>{appNotifications[0].message}</p>
                {appNotifications.length > 1 && (
                  <div className={`mt-4 rounded-lg border p-3 text-sm ${theme === 'dark' ? 'border-slate-800 bg-slate-950/60 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                    还有 {appNotifications.length - 1} 条通知，确认当前通知后会继续显示。
                  </div>
                )}
                {getNotificationProductPath(appNotifications[0]) && (
                  <button
                    type="button"
                    onClick={() => openNotificationProductFolder(appNotifications[0])}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-bold text-white hover:bg-slate-600"
                  >
                    <FolderOpen className="h-4 w-4" />
                    打开产品文件夹
                  </button>
                )}
                {appNotifications[0].project_id && (
                  <button
                    type="button"
                    onClick={() => openNotificationNewDev(appNotifications[0])}
                    className="mt-4 ml-2 inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500"
                  >
                    <Package className="h-4 w-4" />
                    打开处理
                  </button>
                )}
              </div>
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              {appNotifications.length > 1 && (
                <button
                  type="button"
                  disabled={notificationLoading}
                  onClick={markAllAppNotificationsRead}
                  className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-600 disabled:opacity-60"
                >
                  全部确认
                </button>
              )}
              <button
                type="button"
                disabled={notificationLoading}
                onClick={() => markAppNotificationRead(appNotifications[0].id)}
                className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                知道了，继续使用
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 顶部导航 */}
      <header className={`border-b ${theme === 'dark' ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-white/80'} backdrop-blur-md sticky top-0 z-30 transition-colors`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 lg:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <img src={appLogo} alt="尚品易站云资产" className="h-10 w-10 shrink-0 object-contain" />
              <h2 className={`min-w-0 truncate text-base font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tight sm:text-lg`}>尚品易站云资产</h2>
            </div>
            <div className={`hidden h-4 w-px md:block ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-300'}`} />
            <div className="flex flex-wrap items-center gap-1">
              <button 
                onClick={() => setActiveTab('files')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all sm:text-sm ${activeTab === 'files' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                资产库
              </button>
              <button 
                onClick={() => setActiveTab('products')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all sm:text-sm ${activeTab === 'products' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                产品管理
              </button>
              <button
                onClick={() => setActiveTab('brands')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all sm:text-sm ${activeTab === 'brands' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                品牌管理
              </button>
              <button
                onClick={() => setActiveTab('newdev')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all sm:text-sm ${activeTab === 'newdev' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                新品开发
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (activeTab === 'files') fetchFiles(currentPath);
                else if (activeTab === 'products') fetchProducts();
                else if (activeTab === 'brands') fetchBrands();
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-semibold transition-all sm:text-sm ${
                theme === 'dark'
                  ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
              title="刷新"
            >
              <RefreshCw className="w-4 h-4" />
              刷新
            </button>

            {(user.permissions.canManageNewDevelopment || user.permissions.canManageUsers || user.username === '任小雨') && (
              <button
                type="button"
                onClick={openManualNotify}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-semibold transition-all sm:text-sm ${
                  theme === 'dark'
                    ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
                title="发布通知"
              >
                <Megaphone className="w-4 h-4" />
                通知
              </button>
            )}

            <button 
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className={`p-1.5 rounded-full border transition-all ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-amber-400' : 'bg-white border-slate-200 text-slate-600'}`}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowUserMenu(prev => !prev)}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-full border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 hover:bg-slate-700' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
              >
                <span className="max-w-24 truncate text-[11px] font-bold text-sky-500 sm:max-w-32 sm:text-xs">{user.role}</span>
                <span className="max-w-20 truncate text-[11px] text-slate-400 sm:max-w-28 sm:text-xs">{user.username}</span>
              </button>
              {showUserMenu && (
                <div className={`absolute right-0 top-full z-[80] mt-2 w-44 rounded-xl border p-1 shadow-2xl ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                  {(user.username === '任小雨' || user.permissions.canManageUsers) && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowUserMenu(false);
                        setShowUserManagement(true);
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm ${theme === 'dark' ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-100'}`}
                    >
                      账号权限设置
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${theme === 'dark' ? 'text-red-300 hover:bg-slate-800' : 'text-red-600 hover:bg-slate-100'}`}
                  >
                    退出登录
                  </button>
                </div>
              )}
            </div>
            <button onClick={handleLogout} className="p-1.5 hover:bg-slate-800 rounded-full text-slate-400 hover:text-red-500 transition-all">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div 
        className="flex flex-1 min-h-0 overflow-hidden relative" 
        onContextMenu={handleContextMenu}
      >
        {/* pointer 拖拽移动幽灵元素 */}
        {customDragGhost && (
          <div
            style={{ left: customDragGhost.x + 14, top: customDragGhost.y + 4, position: 'fixed', zIndex: 9999, pointerEvents: 'none' }}
            className="bg-slate-900 text-slate-100 border border-slate-600 px-3 py-1.5 rounded-lg text-sm shadow-2xl whitespace-nowrap flex items-center gap-2"
          >
            <span className="text-sky-400">✦</span>
            {customDragGhost.label}
          </div>
        )}
        {/* 拖拽时底部取消条（右键或拖到此处取消） */}
        {customDragGhost && (
          <div
            data-drag-cancel
            style={{ zIndex: 9998 }}
            className={`fixed bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full shadow-2xl border transition-all duration-150 select-none cursor-pointer ${
              dragOverPath === '__cancel__'
                ? 'bg-red-600 border-red-400 text-white scale-110'
                : 'bg-slate-800/95 border-slate-600 text-slate-300 hover:border-red-500 hover:text-red-400'
            }`}
          >
            <span className="text-base">✕</span>
            <span className="text-sm font-medium">拖到此处取消 · 或按 Esc / 右键</span>
          </div>
        )}
        {/* 拖拽上传遮罩 */}
        <AnimatePresence>
          {isDragging && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 bg-sky-600/20 backdrop-blur-sm border-4 border-dashed border-sky-500 flex flex-col items-center justify-center pointer-events-none"
            >
              <div className="bg-slate-900 p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-4 pointer-events-none">
                <Upload className="w-16 h-16 text-sky-500 animate-bounce" />
                <h2 className="text-2xl font-bold text-white">松开鼠标上传到当前目录</h2>
                <p className="text-slate-400">支持拖拽多个文件或文件夹</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 主内容区 */}
        <main
          ref={mainScrollRef as React.RefObject<HTMLElement>}
          data-file-list
          className={`flex-1 min-h-0 overflow-y-auto overflow-x-auto p-6 transition-colors duration-150 ${dragOverPath === '__filelist__' ? (theme === 'dark' ? 'bg-sky-950/30' : 'bg-sky-50/60') : ''}`}
          onMouseDown={handleFileListMouseDown}
        >
          {/* 拖拽到当前目录空白区域时的提示条 */}
          {dragOverPath === '__filelist__' && (
            <div className="pointer-events-none fixed inset-x-0 top-1/2 -translate-y-1/2 flex justify-center z-[9990]">
              <div className={`px-6 py-3 rounded-2xl text-sm font-semibold shadow-2xl border ${theme === 'dark' ? 'bg-slate-900/95 border-sky-500 text-sky-300' : 'bg-white/95 border-sky-500 text-sky-700'}`}>
                松开鼠标 → 移动到当前目录
              </div>
            </div>
          )}
          {activeTab === 'files' ? (
            <>
              <div className="flex items-center justify-between gap-4 mb-6">
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="flex min-w-0 items-center text-sm text-slate-400 gap-1">
                    {searchQuery.trim() ? (
                      <span className="text-indigo-400 font-medium">搜索: {searchQuery}</span>
                    ) : (
                      <>
                        {currentPath ? (
                          <button 
                            onClick={() => navigateTo(pathParts(currentPath).slice(0, -1).join('/'))} 
                            className={`flex items-center gap-1 px-2 py-1 rounded-md ${theme === 'dark' ? 'hover:bg-slate-800 text-slate-400 hover:text-sky-500' : 'hover:bg-slate-100 text-slate-500 hover:text-sky-600'} transition-colors`}
                            title="返回上一级"
                          >
                            <ChevronLeft className="w-4 h-4" />
                            上一级
                          </button>
                        ) : null}
                        <div className="flex min-w-0 items-center gap-1">
                          <button
                            data-bc-path=""
                            onClick={() => navigateTo('')}
                            className={`shrink-0 hover:text-sky-500 transition-colors rounded px-1 ${dragOverPath === '__bc__' ? 'bg-sky-600/30 text-sky-400 ring-1 ring-sky-500' : ''}`}
                          >根目录</button>
                          <div
                            ref={breadcrumbScrollRef}
                            className="no-scrollbar flex min-w-0 max-w-[32vw] items-center gap-1 overflow-x-auto scroll-smooth"
                          >
                            {pathParts(currentPath).map((p, i, arr) => {
                              const segPath = arr.slice(0, i + 1).join('/');
                              const bcKey = `__bc__${segPath}`;
                              return (
                                <React.Fragment key={i}>
                                  <ChevronRight className="w-4 h-4 shrink-0 text-slate-600" />
                                  <button
                                    data-bc-path={segPath}
                                    onClick={() => navigateTo(segPath)}
                                    className={`shrink-0 hover:text-sky-500 transition-colors whitespace-nowrap rounded px-1 ${dragOverPath === bcKey ? 'bg-sky-600/30 text-sky-400 ring-1 ring-sky-500' : ''}`}
                                  >
                                    {p}
                                  </button>
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <button 
                      onClick={handleSelectAll}
                      className={`px-2 py-1 rounded text-xs font-medium ${selectedPaths.size === filteredFiles.length && filteredFiles.length > 0 ? 'bg-sky-600 text-white' : (theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900')}`}
                    >
                      全选
                    </button>
                    <button 
                      onClick={() => setViewMode('grid')}
                      className={`p-2 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-sky-600 text-white' : (theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:text-white' : 'bg-white border border-slate-200 text-slate-400 hover:text-slate-900')}`}
                    >
                      <Grid className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => setViewMode('list')}
                      className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-sky-600 text-white' : (theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:text-white' : 'bg-white border border-slate-200 text-slate-400 hover:text-slate-900')}`}
                    >
                      <ListIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div
                  className="flex shrink-0 items-center gap-3"
                  onMouseDown={(e) => {
                    // 避免触发文件区“框选”逻辑：否则点工具栏按钮会先开始框选，mouseup 时清空选中，导致按钮点击看起来“没反应”
                    e.stopPropagation();
                  }}
                >
                  {selectedPaths.size > 0 && (
                    <span className="text-sm text-slate-400">
                      已选 {selectedPaths.size} 项
                    </span>
                  )}
                  {selectedPaths.size > 0 && (
                    <>
                      {user.permissions.canDelete && (
                        <button 
                          type="button"
                          onClick={async () => {
                            // 这里优先用 ref（解决“全选后立即点删除”可能读取到旧 state 的问题）
                            // 若 ref 意外为空，则回退到当前渲染的 state，避免出现“点了没反应”
                            const fromRef = [...selectedPathsRef.current] as string[];
                            const fromState = [...selectedPaths] as string[];
                            const paths = (fromRef.length ? fromRef : fromState) as string[];
                            if (!paths.length) return;
                            if (!confirm(`确定要删除选中的 ${paths.length} 个项目吗？`)) return;
                            setBatchDeleting(true);
                            let failed = 0;
                            try {
                              for (const p of paths) {
                                try {
                                  const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(p)}`, {
                                    method: 'DELETE',
                                    headers: { 'Authorization': `Bearer ${user.token}` }
                                  });
                                  if (!res.ok) {
                                    const data = await res.json().catch(() => ({}));
                                    console.warn('删除失败', p, data);
                                    failed++;
                                  }
                                } catch (e) {
                                  console.warn('删除请求异常', p, e);
                                  failed++;
                                }
                              }
                              {
                                const next = new Set<string>();
                                selectedPathsRef.current = next;
                                setSelectedPaths(next);
                              }
                              await fetchFiles(currentPath);
                              if (failed > 0) alert(`已删除 ${paths.length - failed} 项，${failed} 项删除失败，请重试或检查权限。`);
                            } finally {
                              setBatchDeleting(false);
                            }
                          }}
                          disabled={batchDeleting}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-4 h-4" />
                          {batchDeleting ? '删除中…' : '删除'}
                        </button>
                      )}
                      {user.permissions.canUpload && (
                        <button
                          type="button"
                          onClick={() => {
                            const paths = [...selectedPathsRef.current]
                            if (!paths.length) return
                            openMoveModal(paths)
                          }}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
                        >
                          <Move className="w-4 h-4" />
                          移动到
                        </button>
                      )}
                      <button 
                        onClick={() => {
                          const currentSel = selectedPathsRef.current;
                          const sel = filteredFiles.filter(f => currentSel.has(f.path));
                          if (!sel.length) return;
                          const electron = (window as any).electron;
                          // 单选且为普通文件：保持原行为，直接下载该文件
                          if (sel.length === 1 && !sel[0].isDir) {
                            handleDownload(sel[0]);
                            return;
                          }
                          const base = window.location.origin;
                          const query = sel
                            .map(f => `paths=${encodeURIComponent(f.path)}`)
                            .join('&');
                          const url = `${base}${API_BASE}/download-zip?${query}&token=${user?.token || ''}`;
                          if (electron?.downloadUrl) {
                            electron.downloadUrl(url);
                          } else {
                            window.open(url, '_blank');
                          }
                        }}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
                      >
                        <Download className="w-4 h-4" />
                        下载
                      </button>
                    </>
                  )}
                  <div className="relative hidden md:block">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input 
                      type="text" 
                      aria-label="搜索资产"
                      className={`w-64 lg:w-80 ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-900'} border rounded-full pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-sky-500 outline-none transition-all`}
                      value={searchQuery}
                      onChange={e => {
                        setSearchQuery(e.target.value);
                        if (savedSearch) setSavedSearch(null);
                      }}
                    />
                    {!searchQuery && (
                      <div className="pointer-events-none absolute left-10 top-1/2 -translate-y-1/2 whitespace-nowrap text-sm text-slate-500">
                        <span>搜索资产,如：削皮刀 </span>
                        <span className="mx-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-bold text-sky-400">空格</span>
                        <span> 主图</span>
                      </div>
                    )}
                    {savedSearch && !searchQuery.trim() && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery(savedSearch.q);
                          setSearchResults(savedSearch.results);
                          setSavedSearch(null);
                        }}
                        className="absolute -bottom-6 left-0 text-[10px] text-indigo-400 hover:underline"
                        title="返回刚才的搜索结果"
                      >
                        返回搜索：{savedSearch.q}
                      </button>
                    )}
                  </div>
                  {user.permissions.canUpload && (
                    <>
                      <button 
                        onClick={() => setShowSmartUpload(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-indigo-900/20"
                      >
                        <Zap className="w-4 h-4" />
                        智能分类上传
                      </button>
                    </>
                  )}
                </div>
              </div>

              {loading ? (
                <div className="flex flex-col items-center justify-center h-64 gap-4">
                  <Loader2 className="w-10 h-10 text-sky-500 animate-spin" />
                  <p className="text-slate-500 text-sm animate-pulse">正在同步云端资产...</p>
                </div>
              ) : (
                <div 
                  ref={fileListRef}
                  className="flex-1 min-h-[400px] relative select-none"
                  style={{ cursor: boxSelect ? 'crosshair' : undefined }}
                >
                <div 
                  className={`${viewMode === 'grid' ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4" : "space-y-2"}`}
                >
                  {boxSelect && (
                    <div 
                      className="fixed border-2 border-sky-500 bg-sky-500/10 pointer-events-none z-40"
                      style={{
                        left: boxSelect.w >= 0 ? boxSelect.x : boxSelect.x + boxSelect.w,
                        top: boxSelect.h >= 0 ? boxSelect.y : boxSelect.y + boxSelect.h,
                        width: Math.abs(boxSelect.w),
                        height: Math.abs(boxSelect.h),
                      }}
                    />
                  )}
                  <AnimatePresence mode="sync">
                    {filteredFiles.map((file, index) => (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        transition={{ duration: 0.12 }}
                        key={file.path}
                        data-file-item
                        data-file-index={index}
                        data-file-path={file.path}
                        data-is-dir={file.isDir ? 'true' : undefined}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          // 阻止浏览器默认的图片/文字拖拽，确保 pointermove/pointerup 持续触发
                          e.preventDefault();
                          const toDrag = selectedPaths.has(file.path) && selectedPaths.size > 1
                            ? Array.from(selectedPaths)
                            : [file.path];
                          const label = toDrag.length > 1 ? `移动 ${toDrag.length} 个项目` : file.name;
                          const downloadUrls = toDrag.map(p =>
                            `${window.location.origin}${API_BASE}/download?path=${encodeURIComponent(p)}&token=${user.token}`
                          );
                          const isDirs = toDrag.map(p => !!filteredFiles.find(f => f.path === p)?.isDir);
                          internalDragPathsRef.current = toDrag;
                          customDragDataRef.current = { paths: toDrag, label, startX: e.clientX, startY: e.clientY, downloadUrls, isDirs };
                        }}
                        onClick={(e) => handleFileClick(file, index, e)}
                        onDoubleClick={() => handleFileDoubleClick(file)}
                        className={`
                          group relative cursor-pointer transition-all select-none
                          ${dragOverPath === file.path
                            ? `ring-2 ring-sky-400 ring-offset-2 ${theme === 'dark' ? 'ring-offset-slate-950 bg-sky-900/30' : 'ring-offset-slate-50 bg-sky-50'}`
                            : selectedPaths.has(file.path) 
                              ? `ring-2 ring-sky-500 ring-offset-2 ${theme === 'dark' ? 'ring-offset-slate-950' : 'ring-offset-slate-50'}` 
                              : ''}
                          ${viewMode === 'grid' 
                            ? `${theme === 'dark' ? 'bg-slate-900 border-slate-800 hover:border-sky-500/50' : 'bg-white border-slate-200 hover:border-sky-500/50'} border rounded-xl p-4 hover:shadow-xl hover:shadow-sky-900/10` 
                            : `${theme === 'dark' ? 'bg-slate-900 border-slate-800 hover:border-sky-500/50' : 'bg-white border-slate-200 hover:border-sky-500/50'} border flex items-center justify-between rounded-lg px-4 py-3`}
                        `}
                      >
                        {/* 拖拽悬停：文件夹显示"移动到此处"提示覆盖层 */}
                        {dragOverPath === file.path && file.isDir && (
                          <div className="absolute inset-0 z-20 rounded-xl flex items-center justify-center pointer-events-none bg-sky-500/20 backdrop-blur-[1px]">
                            <span className={`text-sm font-semibold px-3 py-1.5 rounded-lg shadow-lg ${theme === 'dark' ? 'bg-slate-900/90 text-sky-300' : 'bg-white/95 text-sky-700'}`}>
                              移动到此处
                            </span>
                          </div>
                        )}
                        <div className={viewMode === 'grid' ? "flex min-h-[190px] flex-col items-center text-center" : "flex items-center gap-4 flex-1"}>
                          <div className={viewMode === 'grid' ? "mb-3 relative flex h-32 w-full items-center justify-center overflow-hidden" : "shrink-0"}>
                            {file.isDir ? (
                              <div className={`${viewMode === 'grid' ? 'relative h-28 w-28' : 'relative h-12 w-12'} flex shrink-0 items-center justify-center overflow-hidden`}>
                                <Folder className={`${viewMode === 'grid' ? 'h-24 w-24' : 'h-10 w-10'} ${theme === 'dark' ? 'text-amber-400 fill-amber-400/20' : 'text-amber-500 fill-amber-500/10'}`} />
                                {file.previews && file.previews.length > 0 && (
                                  <div className={`${viewMode === 'grid' ? 'absolute inset-4' : 'absolute inset-2'} grid grid-cols-2 gap-0.5 overflow-hidden rounded-md pointer-events-none`}>
                                    {file.previews.map((prev, idx) => (
                                      <img 
                                        key={idx}
                                        src={`${API_BASE}/thumbnail?path=${encodeURIComponent(prev)}&token=${user.token}`}
                                        className="w-full h-full object-cover rounded-[1px]"
                                        referrerPolicy="no-referrer"
                                        draggable={false}
                                      />
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.psd', '.pdf', '.ai'].includes((file.ext || '').toLowerCase()) ? (
                                (() => {
                                  const ext = (file.ext || '').toLowerCase();
                                  const isSourceFile = ['.ai', '.psd', '.pdf'].includes(ext);
                                  const barStyle = isSourceFile ? {
                                    '.ai': { bg: '#f97316', label: 'AI' },
                                    '.psd': { bg: '#3b82f6', label: 'PSD' },
                                    '.pdf': { bg: '#ef4444', label: 'PDF' },
                                  }[ext] : null;
                                  const thumb = (
                                    <div className="relative w-32 h-32 overflow-hidden rounded-t-lg bg-slate-900/80 flex items-center justify-center">
                                      <img 
                                        src={`${API_BASE}/thumbnail?path=${encodeURIComponent(file.path)}&token=${user.token}`} 
                                        alt={file.name}
                                        className="max-w-full max-h-full object-contain"
                                        referrerPolicy="no-referrer"
                                        draggable={false}
                                        onError={(e) => {
                                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                                          (e.currentTarget as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                                        }}
                                      />
                                      <div className="hidden absolute inset-0 flex items-center justify-center bg-slate-800/50">
                                        {getFileIcon(file)}
                                      </div>
                                    </div>
                                  );
                                  if (barStyle) {
                                    return (
                                      <div className="flex flex-col w-32 rounded-lg overflow-hidden shadow-md">
                                        {thumb}
                                        <div className="h-6 w-32 flex items-center justify-center text-[11px] font-bold text-white" style={{ backgroundColor: barStyle.bg }}>
                                          {barStyle.label}
                                        </div>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div className="relative w-32 h-32 bg-slate-900/80 rounded-lg flex items-center justify-center">
                                      <img 
                                        src={`${API_BASE}/thumbnail?path=${encodeURIComponent(file.path)}&token=${user.token}`} 
                                        alt={file.name}
                                        className="max-w-full max-h-full object-contain shadow-md"
                                        referrerPolicy="no-referrer"
                                        draggable={false}
                                        onError={(e) => {
                                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                                          (e.currentTarget as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                                        }}
                                      />
                                      <div className="hidden absolute inset-0 flex items-center justify-center rounded-lg bg-slate-800/50">
                                        {getFileIcon(file)}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : getFileIcon(file)
                            )}
                          </div>
                          <div className={viewMode === 'grid' ? "w-full min-w-0" : "flex-1 min-w-0"}>
                            <h3 className={`text-sm font-medium ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'} truncate w-full group-hover:text-sky-500 transition-colors`} title={file.name}>
                              {file.name}
                            </h3>
                            <div className="flex flex-wrap gap-1 mt-1 justify-center">
                              {file.products?.map((p, idx) => (
                                <span key={`${p.id}-${p.variant_id}-${idx}`} className="text-[8px] bg-sky-500/20 text-sky-400 px-1 rounded border border-sky-500/30">
                                  {p.variant_sku ? `${p.sku} (${p.variant_sku})` : p.sku}
                                </span>
                              ))}
                            </div>
                            <p className="text-[10px] text-slate-500 uppercase tracking-tighter mt-0.5">
                              {file.isDir ? '文件夹' : `${formatSize(file.size)} • ${file.ext.slice(1)}`}
                            </p>
                          </div>
                        </div>

                        <div className={`
                          flex items-center gap-1
                          ${viewMode === 'grid' ? "absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-all" : ""}
                        `}>
                          {!file.isDir && (
                            <button 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setShowTaggingModal({ 
                                  files: [{ name: file.name, path: file.path }], 
                                  selectedProductIds: Array.from(new Set(file.products?.map(p => p.id) || [])),
                                  selectedVariantIds: file.products?.filter(p => p.variant_id).map(p => p.variant_id!) || []
                                }); 
                              }}
                              className="p-1.5 hover:bg-slate-800 rounded-md text-slate-400 hover:text-sky-500 transition-all"
                              title="打标签"
                            >
                              <Tag className="w-4 h-4" />
                            </button>
                          )}
                          <button 
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              const electron = (window as any).electron;
                              if (!file.isDir) {
                                handleDownload(file);
                              } else {
                                const base = window.location.origin;
                                const url = `${base}${API_BASE}/download-zip?paths=${encodeURIComponent(file.path)}&token=${user?.token || ''}`;
                                if (electron?.downloadUrl) {
                                  electron.downloadUrl(url);
                                } else {
                                  window.open(url, '_blank');
                                }
                              }
                            }}
                            className="p-1.5 hover:bg-slate-800 rounded-md text-slate-400 hover:text-sky-500 transition-all"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          {user.permissions.canDelete && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleDelete(file); }}
                              className="p-1.5 hover:bg-slate-800 rounded-md text-slate-400 hover:text-red-500 transition-all"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
                </div>
              )}
            </>
          ) : activeTab === 'products' ? (
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <h2 className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tight`}>
                    产品管理
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="搜索 SKU 或名称..."
                      className={`w-64 ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border rounded-full pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-sky-500 outline-none transition-all`}
                      value={productSearchQuery}
                      onChange={e => setProductSearchQuery(e.target.value)}
                    />
                  </div>
                  {user.permissions.canManageProducts && (
                    <button 
                      onClick={() => {
                        setIsEditingProduct(false);
                        setProductImageFile(null);
                        setSelectedFolderPath([]);
                        setNewProductForm({ 
                          id: undefined,
                          sku: '', 
                          official_name: '',
                          names: '', 
                          brand_id: undefined,
                          image_path: '', 
                          variants: [],
                          folders: cloneProductFolderTree(productFolderTemplate)
                        });
                        setShowAddProductModal(true);
                      }}
                      className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg font-bold transition-all flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      添加产品
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {products.filter(p => {
                  const query = productSearchQuery.toLowerCase();
                  return p.sku.toLowerCase().includes(query) || 
                         p.official_name?.toLowerCase().includes(query) || 
                         p.names.toLowerCase().includes(query) ||
                         p.brand_name?.toLowerCase().includes(query);
                }).map(product => (
                  <div 
                    key={product.id} 
                    className={`p-4 rounded-xl border ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} flex gap-4 group relative hover:border-sky-500/50 transition-all`}
                    onDoubleClick={() => handleEditProduct(product)}
                  >
                    <div className={`relative w-20 h-20 rounded-lg ${theme === 'dark' ? 'bg-slate-800' : 'bg-slate-100'} flex items-center justify-center overflow-hidden border ${theme === 'dark' ? 'border-slate-700' : 'border-slate-200'}`}>
                      {product.image_path ? (
                        <>
                          <img 
                            src={`${API_BASE}/thumbnail?path=${encodeURIComponent(String(product.image_path).replace(/\\/g, '/'))}&token=${user.token}`} 
                            alt={product.sku}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              const t = e.target as HTMLImageElement;
                              t.style.display = 'none';
                              const place = t.parentElement?.querySelector('.product-thumb-placeholder');
                              if (place) place.classList.remove('hidden');
                            }}
                          />
                          <div className="product-thumb-placeholder absolute inset-0 hidden flex items-center justify-center">
                            <Package className="w-8 h-8 text-slate-500" />
                          </div>
                        </>
                      ) : (
                        <Package className="w-8 h-8 text-slate-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-sky-500 uppercase tracking-wider bg-sky-500/10 px-1.5 py-0.5 rounded">{product.sku}</span>
                          {product.brand_name && (
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider bg-slate-800 px-1.5 py-0.5 rounded">{product.brand_name}</span>
                          )}
                        </div>
                        {user.permissions.canManageProducts && (
                          <div className="flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100">
                            <button
                              type="button"
                              title="通知图片更新"
                              onClick={(e) => {
                                e.stopPropagation();
                                openImageUpdateNotify(product);
                              }}
                              className="p-1 hover:bg-amber-500/10 text-slate-500 hover:text-amber-400 rounded transition-all"
                            >
                              <Bell className="w-4 h-4" />
                            </button>
                            {user.permissions.canDelete && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteProduct(product.id);
                                }}
                                className="p-1 hover:bg-red-500/10 text-slate-500 hover:text-red-500 rounded transition-all"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <h4 className={`text-sm font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} truncate`}>{product.official_name || '未命名产品'}</h4>
                      <div className="flex flex-wrap gap-1 mt-1 opacity-60">
                        {product.names.split(',').map((name, i) => (
                          <span key={i} className={`text-[10px] ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'} truncate`}>
                            {name}{i < product.names.split(',').length - 1 ? ' • ' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeTab === 'brands' ? (
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <h2 className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tight`}>
                    品牌管理
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  {user.permissions.canManageBrands && (
                    <button 
                      onClick={() => setShowAddBrandModal(true)}
                      className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg font-bold transition-all flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      添加品牌
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {brands.map(brand => (
                  <div key={brand.id} className={`p-4 rounded-xl border ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} flex items-center justify-between group`}>
                    <span className={`font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{brand.name}</span>
                    {user.permissions.canDelete && user.permissions.canManageBrands && (
                      <button 
                        onClick={() => handleDeleteBrand(brand.id)}
                        className="p-1 hover:bg-red-500/10 text-slate-500 hover:text-red-500 rounded transition-all opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                {user.permissions.canManageBrands && (
                  <button 
                    onClick={() => setShowAddBrandModal(true)}
                    className={`p-4 rounded-xl border-2 border-dashed ${theme === 'dark' ? 'border-slate-800 text-slate-500 hover:border-sky-500 hover:text-sky-500' : 'border-slate-200 text-slate-400 hover:border-sky-500 hover:text-sky-500'} flex flex-col items-center justify-center gap-2 transition-all`}
                  >
                    <Plus className="w-5 h-5" />
                    <span className="text-xs font-bold">添加品牌</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className={`flex h-64 items-center justify-center gap-2 rounded-xl border text-sm ${theme === 'dark' ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-white text-slate-500'}`}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载中...
                </div>
              }
            >
              <NewDevelopmentSystem theme={theme} user={user} isActive={activeTab === 'newdev'} openTarget={newDevOpenTarget} onOpenTargetHandled={() => setNewDevOpenTarget(null)} />
            </Suspense>
          )}
        </main>

      </div>

      {/* 右键菜单 */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={`fixed z-50 min-w-[160px] ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-lg shadow-2xl p-1`}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.path && contextMenu.isDir === false && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    // 在程序内部打开：跳转到文件所在目录，并选中该文件
                    const filePath = contextMenu.path!;
                    const parts = pathParts(filePath);
                    const dir = parts.slice(0, -1).join('/');
                    // 若当前在搜索模式，先保存搜索状态，避免用户觉得“东西没了”
                    if (searchQuery.trim()) {
                      setSavedSearch({ q: searchQuery, results: searchResults ?? null });
                      setSearchQuery('');
                      setSearchResults(null);
                    }
                    navigateTo(dir); // 进入目录视图
                    const next = new Set<string>([filePath]);
                    selectedPathsRef.current = next;
                    setSelectedPaths(next);
                  } finally {
                    closeContextMenu();
                  }
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-all ${theme === 'dark' ? 'hover:bg-slate-800 text-slate-300 hover:text-white' : 'hover:bg-slate-100 text-slate-600 hover:text-slate-900'}`}
              >
                <Folder className="w-4 h-4" />
                打开文件所在文件夹
              </button>
            )}
            {user.permissions.canUpload && (
              <button
                type="button"
                onClick={() => {
                  const clickedPath = contextMenu?.path
                  // 如果右键的文件在已选中集合里，则移动全部选中项；否则只移动该文件
                  const paths = clickedPath && selectedPathsRef.current.has(clickedPath) && selectedPathsRef.current.size > 1
                    ? [...selectedPathsRef.current]
                    : clickedPath
                      ? [clickedPath]
                      : [...selectedPathsRef.current]
                  closeContextMenu()
                  openMoveModal(paths)
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-all ${theme === 'dark' ? 'hover:bg-slate-800 text-slate-300 hover:text-white' : 'hover:bg-slate-100 text-slate-600 hover:text-slate-900'}`}
              >
                <Move className="w-4 h-4" />
                移动到文件夹
              </button>
            )}
            <button 
              onClick={() => fetchFiles(currentPath)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-all ${theme === 'dark' ? 'hover:bg-slate-800 text-slate-300 hover:text-white' : 'hover:bg-slate-100 text-slate-600 hover:text-slate-900'}`}
            >
              <Loader2 className="w-4 h-4" />
              刷新列表
            </button>
          </motion.div>
        )}

        <AnimatePresence>
          {downloadToast && (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              className="pointer-events-none fixed bottom-6 left-1/2 z-[70] w-[min(92vw,520px)] -translate-x-1/2"
            >
              <div className={`pointer-events-auto rounded-2xl border shadow-2xl ${theme === 'dark' ? 'border-slate-700 bg-slate-900/95 text-slate-100' : 'border-slate-200 bg-white/95 text-slate-900'} backdrop-blur`}>
                <div className="flex items-start gap-3 p-4">
                  <div className={`mt-0.5 rounded-full p-2 ${downloadToast.state === 'completed' ? 'bg-sky-500/15 text-sky-400' : downloadToast.state === 'failed' || downloadToast.state === 'interrupted' ? 'bg-rose-500/15 text-rose-400' : 'bg-sky-500/15 text-sky-400'}`}>
                    {downloadToast.state === 'completed' ? <Check className="h-4 w-4" /> : downloadToast.state === 'failed' || downloadToast.state === 'interrupted' ? <X className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold">{downloadToast.filename}</div>
                        <div className={`mt-1 text-xs ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
                          {formatDownloadToastText(downloadToast.state)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={closeDownloadToast}
                        className={`rounded-full p-1.5 ${theme === 'dark' ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                        aria-label="关闭下载进度"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className={`mt-3 h-2 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-slate-800' : 'bg-slate-200'}`}>
                      <div
                        className={`h-full rounded-full transition-all ${downloadToast.state === 'completed' ? 'bg-sky-500' : downloadToast.state === 'failed' || downloadToast.state === 'interrupted' ? 'bg-rose-500' : 'bg-sky-500'}`}
                        style={{ width: `${Math.max(6, Math.min(100, downloadToast.totalBytes > 0 ? (downloadToast.receivedBytes / downloadToast.totalBytes) * 100 : downloadToast.state === 'completed' ? 100 : 12))}%` }}
                      />
                    </div>
                    <div className={`mt-2 flex items-center justify-between text-xs ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span>{downloadToast.totalBytes > 0 ? `${Math.round((downloadToast.receivedBytes / downloadToast.totalBytes) * 100)}%` : '准备中'}</span>
                      <span>{`${(downloadToast.receivedBytes / 1024 / 1024).toFixed(1)} MB / ${downloadToast.totalBytes > 0 ? `${(downloadToast.totalBytes / 1024 / 1024).toFixed(1)} MB` : '--'}`}</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </AnimatePresence>

      {showUserManagement && (
        <UserManagementModal
          theme={theme}
          user={user}
          onClose={() => setShowUserManagement(false)}
        />
      )}

      <AnimatePresence>
        {showManualNotify && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) setShowManualNotify(false); }}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 20 }}
              className={`flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border p-5 shadow-2xl ${theme === 'dark' ? 'border-slate-800 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-bold">发布通知</h3>
                  <p className="mt-1 text-xs text-slate-500">选择通知人员或部门，通知会弹窗提醒对应用户。</p>
                </div>
                <button onClick={() => setShowManualNotify(false)} className="rounded-full p-2 text-slate-500 hover:bg-slate-800 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid gap-4 md:grid-cols-2">
                <div className={`rounded-xl border p-3 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="mb-2 text-sm font-bold">按部门通知</div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-800">
                    {notificationDepartments.map(dept => (
                      <div key={dept} className={`flex items-center justify-between gap-2 py-2 text-sm ${manualNotifyDepartmentView === dept ? 'text-sky-400' : ''}`}>
                        <button type="button" onClick={() => setManualNotifyDepartmentView(dept)} className="min-w-0 flex-1 truncate text-left font-semibold">
                          {dept}
                        </button>
                        <label className="flex items-center gap-2 text-xs text-slate-500">
                          全部
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-sky-500"
                            checked={manualNotifyForm.departments.includes(dept)}
                            onChange={() => setManualNotifyForm(prev => ({
                              ...prev,
                              departments: prev.departments.includes(dept)
                                ? prev.departments.filter(v => v !== dept)
                                : [...prev.departments, dept]
                            }))}
                          />
                        </label>
                      </div>
                    ))}
                    {!notificationDepartments.length && <div className="py-4 text-center text-sm text-slate-500">暂无部门</div>}
                  </div>
                </div>

                <div className={`rounded-xl border p-3 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="mb-2 flex items-center justify-between gap-2 text-sm font-bold">
                    <span>{manualNotifyDepartmentView ? `${manualNotifyDepartmentView}人员` : '按人员通知'}</span>
                    {manualNotifyDepartmentView && <button type="button" onClick={() => setManualNotifyDepartmentView(null)} className="text-xs text-sky-400">查看全部</button>}
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-800">
                    {manualNotifyVisibleUsers.map(member => (
                      <label key={member.username} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span className="font-semibold">{member.username}</span>
                        <span className="flex items-center gap-2 text-xs text-slate-500">
                          {member.role}
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-sky-500"
                            checked={manualNotifyForm.usernames.includes(member.username)}
                            onChange={() => setManualNotifyForm(prev => ({
                              ...prev,
                              usernames: prev.usernames.includes(member.username)
                                ? prev.usernames.filter(v => v !== member.username)
                                : [...prev.usernames, member.username]
                            }))}
                          />
                        </span>
                      </label>
                    ))}
                    {!manualNotifyVisibleUsers.length && <div className="py-4 text-center text-sm text-slate-500">暂无账号</div>}
                  </div>
                </div>
              </div>

              <label className="mt-5 block text-sm font-semibold">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-500"
                    checked={manualNotifyProductMode}
                    onChange={e => {
                      setManualNotifyProductMode(e.target.checked);
                      if (!e.target.checked) {
                        setManualNotifyProductSearch('');
                        setManualNotifyProduct(null);
                      }
                    }}
                  />
                  是否为更新产品信息？
                </span>
              </label>

              {manualNotifyProductMode && (
                <div className={`mt-3 rounded-xl border p-3 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="text-sm font-bold">选择更新的产品</div>
                  <input
                    value={manualNotifyProductSearch}
                    onChange={e => setManualNotifyProductSearch(e.target.value)}
                    placeholder="搜索产品名称、货号、别名或品牌"
                    className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500 ${theme === 'dark' ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
                  />
                  {manualNotifyProduct && (
                    <div className="mt-2 rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-sky-300">
                      已选择：{manualNotifyProduct.official_name || manualNotifyProduct.sku} / {manualNotifyProduct.sku}
                    </div>
                  )}
                  <div className="mt-2 max-h-44 overflow-y-auto space-y-1">
                    {manualNotifyFilteredProducts.map(product => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => {
                          setManualNotifyProduct(product);
                          setManualNotifyProductSearch(product.official_name || product.sku);
                          if (!manualNotifyForm.title.trim()) {
                            setManualNotifyForm(prev => ({ ...prev, title: `产品信息更新：${product.official_name || product.sku}` }));
                          }
                        }}
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${manualNotifyProduct?.id === product.id ? 'bg-sky-600 text-white' : theme === 'dark' ? 'bg-slate-900 hover:bg-slate-800' : 'bg-white hover:bg-slate-100'}`}
                      >
                        <div className="font-bold">{product.official_name || product.sku}</div>
                        <div className="mt-0.5 text-xs opacity-70">{product.sku} {product.brand_name ? `/ ${product.brand_name}` : ''}</div>
                      </button>
                    ))}
                    {!manualNotifyFilteredProducts.length && <div className="py-3 text-center text-sm text-slate-500">没有匹配的产品</div>}
                  </div>
                </div>
              )}

              <label className="mt-5 block text-sm font-semibold">
                通知标题
                <input
                  value={manualNotifyForm.title}
                  onChange={e => setManualNotifyForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="例如：请更新产品图片"
                  className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500 ${theme === 'dark' ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
                />
              </label>

              <label className="mt-4 block text-sm font-semibold">
                通知内容
                <textarea
                  rows={4}
                  value={manualNotifyForm.message}
                  onChange={e => setManualNotifyForm(prev => ({ ...prev, message: e.target.value }))}
                  placeholder="填写需要通知的具体事项"
                  className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500 ${theme === 'dark' ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
                />
              </label>
              </div>

              <div className="mt-5 flex justify-end gap-3">
                <button onClick={() => { setShowManualNotify(false); window.setTimeout(() => setSuppressNotificationModal(false), 200); }} className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-600">
                  取消
                </button>
                <button
                  disabled={sendingManualNotify}
                  onClick={sendManualNotify}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Megaphone className="h-4 w-4" />
                  {sendingManualNotify ? '发送中...' : '发送通知'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {imageNotifyProduct && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setImageNotifyProduct(null); }}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              className={`w-full max-w-3xl rounded-2xl border p-6 shadow-2xl ${theme === 'dark' ? 'border-slate-800 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold">通知图片更新</h3>
                  <p className="mt-1 text-sm text-slate-500">{imageNotifyProduct.official_name || imageNotifyProduct.sku}</p>
                </div>
                <button onClick={() => setImageNotifyProduct(null)} className="rounded-full p-2 text-slate-500 hover:bg-slate-800 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-bold text-slate-500">通知部门</div>
                  <div className={`max-h-56 overflow-y-auto rounded-xl border p-3 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
                    {notificationDepartments.map(dept => (
                      <label key={dept} className="flex items-center gap-2 py-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-sky-500"
                          checked={imageNotifyForm.departments.includes(dept)}
                          onChange={() => setImageNotifyForm(prev => ({
                            ...prev,
                            departments: prev.departments.includes(dept)
                              ? prev.departments.filter(v => v !== dept)
                              : [...prev.departments, dept]
                          }))}
                        />
                        {dept}全部
                      </label>
                    ))}
                    {!notificationDepartments.length && <div className="py-4 text-center text-sm text-slate-500">暂无部门</div>}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-bold text-slate-500">通知人员</div>
                  <div className={`max-h-56 overflow-y-auto rounded-xl border p-3 ${theme === 'dark' ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
                    {notifyUsers.map(member => (
                      <label key={member.username} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span className="font-semibold">{member.username}</span>
                        <span className="flex items-center gap-2 text-xs text-slate-500">
                          {member.role}
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-sky-500"
                            checked={imageNotifyForm.usernames.includes(member.username)}
                            onChange={() => setImageNotifyForm(prev => ({
                              ...prev,
                              usernames: prev.usernames.includes(member.username)
                                ? prev.usernames.filter(v => v !== member.username)
                                : [...prev.usernames, member.username]
                            }))}
                          />
                        </span>
                      </label>
                    ))}
                    {!notifyUsers.length && <div className="py-4 text-center text-sm text-slate-500">暂无账号</div>}
                  </div>
                </div>
              </div>

              <label className="mt-5 block text-sm font-semibold">
                补充说明
                <textarea
                  rows={3}
                  value={imageNotifyForm.message}
                  onChange={e => setImageNotifyForm(prev => ({ ...prev, message: e.target.value }))}
                  placeholder="例如：主图和详情页已替换，请运营同步更新。"
                  className={`mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500 ${theme === 'dark' ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
                />
              </label>

              <div className="mt-5 flex justify-end gap-3">
                <button onClick={() => setImageNotifyProduct(null)} className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-600">
                  取消
                </button>
                <button
                  disabled={sendingImageNotify}
                  onClick={sendImageUpdateNotify}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Bell className="h-4 w-4" />
                  {sendingImageNotify ? '发送中...' : '发送通知'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 移动到文件夹 弹窗 */}
      <AnimatePresence>
        {showMoveModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowMoveModal(false) }}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              className={`w-full max-w-md ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl shadow-2xl flex flex-col`}
              style={{ maxHeight: '80vh' }}
            >
              {/* 标题 */}
              <div className={`px-6 py-4 border-b ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'} flex items-center justify-between`}>
                <div>
                  <h3 className={`text-base font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>移动到文件夹</h3>
                  <p className="text-xs text-slate-500 mt-0.5">已选 {movePaths.length} 个项目</p>
                </div>
                <button
                  onClick={() => setShowMoveModal(false)}
                  className="p-2 hover:bg-slate-800 rounded-full text-slate-500 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 目标路径面包屑 */}
              <div className={`px-6 py-3 border-b ${theme === 'dark' ? 'border-slate-800 bg-slate-800/30' : 'border-slate-200 bg-slate-50'} flex items-center gap-1 flex-wrap text-xs`}>
                <button
                  onClick={() => { setMoveBrowsePath(''); loadMoveBrowse('') }}
                  className={`font-medium ${moveBrowsePath === '' ? 'text-sky-500' : (theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900')} transition-colors`}
                >
                  根目录
                </button>
                {moveBrowsePath === '' && moveInitialPath === '' && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400">当前位置</span>
                )}
                {pathParts(moveBrowsePath).map((p, i, arr) => {
                  const segPath = arr.slice(0, i + 1).join('/')
                  const isLast = i === arr.length - 1
                  const isOrigin = segPath === moveInitialPath
                  return (
                    <React.Fragment key={i}>
                      <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
                      <button
                        onClick={() => {
                          setMoveBrowsePath(segPath)
                          loadMoveBrowse(segPath)
                        }}
                        className={`font-medium truncate max-w-[120px] ${isLast ? 'text-sky-500' : (theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900')} transition-colors`}
                      >
                        {p}
                      </button>
                      {isLast && isOrigin && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400">当前位置</span>
                      )}
                    </React.Fragment>
                  )
                })}
              </div>

              {/* 文件夹列表 */}
              <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
                {moveBrowsePath !== '' && (
                  <button
                    onClick={() => {
                      const parent = pathParts(moveBrowsePath).slice(0, -1).join('/')
                      setMoveBrowsePath(parent)
                      loadMoveBrowse(parent)
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-1 ${theme === 'dark' ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'} transition-colors`}
                  >
                    <ChevronLeft className="w-4 h-4 flex-shrink-0" />
                    上一级
                  </button>
                )}
                {moveBrowseLoading ? (
                  <div className="flex items-center justify-center h-24">
                    <Loader2 className="w-5 h-5 animate-spin text-sky-500" />
                  </div>
                ) : moveBrowseItems.length === 0 ? (
                  <p className="text-center text-slate-500 text-sm py-8">当前目录没有子文件夹</p>
                ) : (
                  <div className="space-y-0.5">
                    {moveBrowseItems.map(folder => {
                      const isOriginFolder = folder.path === moveInitialPath
                      return (
                        <button
                          key={folder.path}
                          onClick={() => {
                            setMoveBrowsePath(folder.path)
                            loadMoveBrowse(folder.path)
                          }}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                            isOriginFolder
                              ? (theme === 'dark' ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300' : 'bg-amber-50 hover:bg-amber-100 text-amber-700')
                              : (theme === 'dark' ? 'hover:bg-slate-800 text-slate-300 hover:text-white' : 'hover:bg-slate-100 text-slate-700 hover:text-slate-900')
                          }`}
                        >
                          <FolderOpen className={`w-4 h-4 flex-shrink-0 ${isOriginFolder ? 'text-amber-400' : 'text-amber-400'}`} />
                          <span className="truncate text-left">{folder.name}</span>
                          {isOriginFolder && (
                            <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400 flex-shrink-0">当前位置</span>
                          )}
                          <ChevronRight className="w-3 h-3 text-slate-500 ml-auto flex-shrink-0" />
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 底部操作区 */}
              <div className={`px-6 py-4 border-t ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'} flex items-center justify-between gap-3`}>
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <FolderOpen className={`w-4 h-4 flex-shrink-0 ${moveBrowsePath === moveInitialPath ? 'text-amber-400' : 'text-sky-500'}`} />
                  <span className={`truncate ${moveBrowsePath === moveInitialPath ? 'text-amber-400' : 'text-slate-500'}`}>
                    {moveBrowsePath === moveInitialPath
                      ? '文件已在此处'
                      : `目标：${moveBrowsePath || '根目录'}`}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setShowMoveModal(false)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'} transition-colors`}
                  >
                    取消
                  </button>
                  <button
                    onClick={() => handleMoveFiles(moveBrowsePath)}
                    disabled={moveExecuting || moveBrowsePath === moveInitialPath}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {moveExecuting ? '移动中…' : '移动到此处'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 新建品牌弹窗 */}
      <AnimatePresence>
        {showAddBrandModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`w-full max-w-sm ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl shadow-2xl overflow-hidden`}
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <h3 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>添加新品牌</h3>
                <button onClick={() => setShowAddBrandModal(false)} className="p-2 hover:bg-slate-800 rounded-full text-slate-500">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase">品牌名称</label>
                  <input 
                    autoFocus
                    type="text" 
                    placeholder="例如: 罗莱家纺"
                    className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                    value={newBrandName}
                    onChange={e => setNewBrandName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateBrand()}
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button 
                    onClick={handleCreateBrand}
                    className="flex-1 bg-sky-600 hover:bg-sky-500 text-white font-bold py-3 rounded-lg transition-all"
                  >
                    确认添加
                  </button>
                  <button 
                    onClick={() => setShowAddBrandModal(false)}
                    className={`flex-1 ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} font-bold py-3 rounded-lg transition-all`}
                  >
                    取消
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 上传同名冲突：三按钮选择 */}
      <AnimatePresence>
        {uploadConflictModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-conflict-title"
            onClick={() => finishUploadConflict(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`w-full max-w-sm ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl shadow-2xl overflow-hidden`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={`p-6 border-b ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
                <h3 id="upload-conflict-title" className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
                  检测到同名文件
                </h3>
                <p className={`mt-2 text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>
                  共 {uploadConflictModal.conflictCount} 个文件与目标位置重名，请选择处理方式。
                </p>
              </div>
              <div className="p-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => finishUploadConflict('overwrite')}
                  className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 rounded-lg transition-all"
                >
                  覆盖替换
                </button>
                <button
                  type="button"
                  onClick={() => finishUploadConflict('rename')}
                  className={`w-full font-bold py-3 rounded-lg transition-all ${theme === 'dark' ? 'bg-slate-800 hover:bg-slate-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-900'}`}
                >
                  自动重命名
                </button>
                <button
                  type="button"
                  onClick={() => finishUploadConflict(null)}
                  className={`w-full font-bold py-3 rounded-lg border transition-all ${theme === 'dark' ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 智能分类上传弹窗 */}
      <AnimatePresence>
        {showSmartUpload && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onDrop={e => { e.preventDefault(); e.stopPropagation(); }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }}
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`w-full max-w-md max-h-[90vh] flex flex-col ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl shadow-2xl overflow-hidden`}
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-indigo-500" />
                  <h3 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>智能分类上传</h3>
                </div>
                <button onClick={() => { setShowSmartUpload(false); setSmartUploadSuccess(null); setSmartUploadPendingFiles([]); setSmartUploadPendingPaths([]); setSmartUploadConfig(prev => ({ ...prev, folders: cloneFolderTree(INITIAL_SMART_UPLOAD_FOLDERS), selectedFolderPath: [], newFolderName: '' })); }} className="p-2 hover:bg-slate-800 rounded-full text-slate-500">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4 relative overflow-y-auto flex-1 min-h-0">
                {smartUploadSuccess ? (
                  <div className="flex flex-col items-center gap-4 py-6">
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center ${theme === 'dark' ? 'bg-sky-500/20' : 'bg-sky-100'}`}>
                      <Check className="w-8 h-8 text-sky-500" />
                    </div>
                    <p className={`text-center font-medium ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
                      已成功上传，并已打上所选产品标签，便于后期查找
                    </p>
                    <div className="flex gap-3 w-full">
                      <button
                        onClick={() => { setSmartUploadSuccess(null); setSmartUploadPendingFiles([]); setSmartUploadPendingPaths([]); }}
                        className={`flex-1 py-3 rounded-lg border font-bold transition-all ${theme === 'dark' ? 'border-slate-600 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                      >
                        继续上传
                      </button>
                      <button
                      onClick={() => { setShowSmartUpload(false); setSmartUploadSuccess(null); setSmartUploadPendingFiles([]); setSmartUploadPendingPaths([]); setSmartUploadConfig(prev => ({ ...prev, folders: cloneFolderTree(INITIAL_SMART_UPLOAD_FOLDERS), selectedFolderPath: [], newFolderName: '' })); }}
                        className="flex-1 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold transition-all"
                      >
                        完成
                      </button>
                    </div>
                  </div>
                ) : (
                <>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase">搜索并选择产品</label>
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="输入 SKU、名称或别名搜索..."
                      className={`w-full pl-10 pr-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-indigo-500 text-sm`}
                      value={smartUploadSearch}
                      onChange={e => {
                        setSmartUploadSearch(e.target.value);
                        setShowSmartSearchResults(true);
                      }}
                      onFocus={() => setShowSmartSearchResults(true)}
                    />
                    
                    {/* 搜索结果下拉列表 */}
                    <AnimatePresence>
                      {showSmartSearchResults && (
                        <>
                          <div 
                            className="fixed inset-0 z-10" 
                            onClick={() => setShowSmartSearchResults(false)}
                          />
                          <motion.div 
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className={`absolute left-0 right-0 top-full mt-1 z-[100] max-h-60 overflow-y-auto rounded-xl border shadow-xl ${theme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
                            onClick={e => e.stopPropagation()}
                            onMouseDown={e => e.stopPropagation()}
                          >
                            {smartUploadFilteredProducts.length > 0 ? (
                              smartUploadFilteredProducts.map(p => (
                                <button
                                  key={p.id}
                                  className={`w-full text-left px-4 py-3 hover:bg-indigo-500/10 transition-colors border-b last:border-0 ${theme === 'dark' ? 'border-slate-700' : 'border-slate-100'}`}
                                  onClick={() => {
                                    if (!smartUploadConfig.productIds.includes(p.id)) {
                                      setSmartUploadConfig({
                                        ...smartUploadConfig, 
                                        productIds: [...smartUploadConfig.productIds, p.id],
                                        variantId: null // 多选时暂不支持规格精确匹配
                                      });
                                    }
                                    setSmartUploadSearch('');
                                    setShowSmartSearchResults(false);
                                  }}
                                >
                                  <div className={`text-sm font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{p.sku}</div>
                                  <div className="text-xs text-slate-500 truncate">{p.official_name}</div>
                                  {p.names && (
                                    <div className="text-[10px] text-slate-400 italic mt-0.5 truncate">别名: {p.names}</div>
                                  )}
                                </button>
                              ))
                            ) : (
                              <div className="p-4 text-center text-sm text-slate-500 italic">未找到匹配产品</div>
                            )}
                          </motion.div>
                        </>
                      )}
                    </AnimatePresence>
                  </div>
                  
                  {/* 已选产品展示 */}
                  {smartUploadConfig.productIds.length > 0 && !showSmartSearchResults && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">已选择 {smartUploadConfig.productIds.length} 个产品</label>
                        <button 
                          onClick={() => setSmartUploadConfig({...smartUploadConfig, productIds: []})}
                          className="text-[10px] text-red-500 hover:underline"
                        >
                          全部清除
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(smartUploadConfig.productIds || []).map(pId => {
                          const p = products.find(prod => prod.id === pId);
                          if (!p) return null;
                          return (
                            <div key={pId} className={`flex items-center gap-2 px-2 py-1 rounded-lg border ${theme === 'dark' ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-indigo-50 border-indigo-100'}`}>
                              <div className="flex-1 min-w-0">
                                <div className={`text-[10px] font-bold truncate ${theme === 'dark' ? 'text-indigo-300' : 'text-indigo-900'}`}>
                                  {p.sku}
                                </div>
                                <div className="text-[8px] text-slate-500 truncate">
                                  {p.official_name}
                                </div>
                              </div>
                              <button 
                                onClick={() => {
                                  setSmartUploadConfig({
                                    ...smartUploadConfig, 
                                    productIds: smartUploadConfig.productIds.filter(id => id !== pId)
                                  });
                                }}
                                className="p-0.5 hover:bg-red-500/10 text-slate-400 hover:text-red-500 rounded"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {smartUploadConfig.productIds.length === 1 && (products || []).find(p => p.id === smartUploadConfig.productIds[0])?.variants?.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">选择二级文件夹 (规格)</label>
                    <select 
                      className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-indigo-500`}
                      value={smartUploadConfig.variantId || ''}
                      onChange={e => setSmartUploadConfig({...smartUploadConfig, variantId: Number(e.target.value) || null})}
                    >
                      <option value="">主目录 (无规格)</option>
                      {(products || []).find(p => p.id === smartUploadConfig.productIds[0])?.variants?.map(v => (
                        <option key={v.id} value={v.id}>{v.sku} {v.color ? `(${v.color})` : ''}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* 上传目录：按实际目录扫描（服务器真实文件夹），可多级进入 */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-500 uppercase">上传目录（可多级，来自实际目录）</label>
                  {!smartUploadBasePath ? (
                    <p className="text-[10px] text-slate-500 italic">请先选择产品，将按该产品实际目录加载文件夹</p>
                  ) : (
                    <>
                      <div className={`flex flex-wrap items-center gap-1 px-2 py-1.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                        <button
                          type="button"
                          onClick={() => setSmartUploadConfig(prev => ({ ...prev, selectedFolderPath: [] }))}
                          className={`text-[10px] font-medium ${smartUploadConfig.selectedFolderPath.length === 0 ? 'text-indigo-500' : (theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800')}`}
                        >
                          根
                        </button>
                        {(smartUploadConfig.selectedFolderPath || []).map((name, idx) => (
                          <React.Fragment key={idx}>
                            <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
                            <button
                              type="button"
                              onClick={() => setSmartUploadConfig(prev => ({ ...prev, selectedFolderPath: prev.selectedFolderPath.slice(0, idx + 1) }))}
                              className={`text-[10px] font-medium truncate max-w-[80px] ${idx === smartUploadConfig.selectedFolderPath.length - 1 ? 'text-indigo-500' : (theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900')}`}
                            >
                              {name}
                            </button>
                          </React.Fragment>
                        ))}
                      </div>
                      {smartUploadConfig.selectedFolderPath.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSmartUploadConfig(prev => ({ ...prev, selectedFolderPath: prev.selectedFolderPath.slice(0, -1) }))}
                          className={`flex items-center gap-1 text-[10px] font-medium ${theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800'}`}
                        >
                          <ChevronLeft className="w-3 h-3" /> 返回上级
                        </button>
                      )}
                      <div className={`p-3 rounded-xl border ${theme === 'dark' ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="text-[10px] font-bold text-slate-500 uppercase mb-2">
                          {smartUploadConfig.selectedFolderPath.length === 0 ? '当前目录下的文件夹' : `「${smartUploadConfig.selectedFolderPath[smartUploadConfig.selectedFolderPath.length - 1]}」下的子文件夹`}
                        </div>
                        {smartUploadDirsLoading ? (
                          <div className="flex items-center gap-2 py-2 text-[10px] text-slate-500">
                            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
                          </div>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {(smartUploadDirs || []).map((name, i) => (
                                <button
                                  key={i}
                                  type="button"
                                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium cursor-pointer transition-all border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'}`}
                                  onClick={() => setSmartUploadConfig(prev => ({ ...prev, selectedFolderPath: [...prev.selectedFolderPath, name] }))}
                                >
                                  {name}
                                  <ChevronRight className="w-3 h-3 text-slate-400" />
                                </button>
                              ))}
                              {smartUploadDirs.length === 0 && !smartUploadDirsLoading && (
                                <span className="text-[9px] text-slate-500 italic">当前目录下无子文件夹，可新建</span>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder={smartUploadConfig.selectedFolderPath.length === 0 ? '新建文件夹名...' : '添加子文件夹...'}
                                className={`flex-1 px-2 py-1 text-[10px] rounded border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-1 focus:ring-indigo-500`}
                                value={smartUploadConfig.newFolderName}
                                onChange={e => setSmartUploadConfig(prev => ({ ...prev, newFolderName: e.target.value }))}
                                onKeyDown={async e => {
                                  if (e.key === 'Enter' && smartUploadConfig.newFolderName.trim()) {
                                    e.preventDefault();
                                    const parentPath = smartUploadConfig.selectedFolderPath.length ? pathJoin(smartUploadBasePath, ...smartUploadConfig.selectedFolderPath) : smartUploadBasePath;
                                    try {
                                      const res = await fetch(`${API_BASE}/mkdir`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user!.token}` },
                                        body: JSON.stringify({ path: parentPath, name: smartUploadConfig.newFolderName.trim() }),
                                      });
                                      if (res.ok) {
                                        setSmartUploadConfig(prev => ({ ...prev, newFolderName: '' }));
                                        fetchSmartUploadDirs();
                                      } else {
                                        const data = await res.json().catch(() => ({}));
                                        alert((data as any).error || '创建失败');
                                      }
                                    } catch { alert('网络错误'); }
                                  }
                                }}
                              />
                              <button
                                type="button"
                                disabled={!smartUploadConfig.newFolderName.trim()}
                                onClick={async () => {
                                  if (!smartUploadConfig.newFolderName.trim() || !user) return;
                                  const parentPath = smartUploadConfig.selectedFolderPath.length ? pathJoin(smartUploadBasePath, ...smartUploadConfig.selectedFolderPath) : smartUploadBasePath;
                                  try {
                                    const res = await fetch(`${API_BASE}/mkdir`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
                                      body: JSON.stringify({ path: parentPath, name: smartUploadConfig.newFolderName.trim() }),
                                    });
                                    if (res.ok) {
                                      setSmartUploadConfig(prev => ({ ...prev, newFolderName: '' }));
                                      fetchSmartUploadDirs();
                                    } else {
                                      const data = await res.json().catch(() => ({}));
                                      alert((data as any).error || '创建失败');
                                    }
                                  } catch { alert('网络错误'); }
                                }}
                                className="px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-500 transition-all text-[10px] disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* 待上传列表 */}
                {(smartUploadPendingFiles.length > 0 || smartUploadPendingPaths.length > 0) && (
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">待上传 ({smartUploadPendingFiles.length + smartUploadPendingPaths.length} 个文件)</label>
                    <div className={`max-h-32 overflow-y-auto rounded-lg border space-y-1 p-2 ${theme === 'dark' ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      {smartUploadPendingFiles.map((f, i) => (
                        <div key={`f-${f.name}-${i}`} className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm ${theme === 'dark' ? 'bg-slate-800' : 'bg-white'}`}>
                          <span className={`truncate flex-1 ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`} title={f.name}>{f.name}</span>
                          <button type="button" onClick={() => setSmartUploadPendingFiles(prev => prev.filter((_, idx) => idx !== i))} className="p-1 hover:bg-red-500/10 text-slate-400 hover:text-red-500 rounded shrink-0"><X className="w-4 h-4" /></button>
                        </div>
                      ))}
                      {smartUploadPendingPaths.map((p, i) => (
                        <div key={`p-${p}-${i}`} className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm ${theme === 'dark' ? 'bg-slate-800' : 'bg-white'}`}>
                          <span className={`truncate flex-1 ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`} title={p}>{p.replace(/^.*[/\\]/, '')}</span>
                          <button type="button" onClick={() => setSmartUploadPendingPaths(prev => prev.filter((_, idx) => idx !== i))} className="p-1 hover:bg-red-500/10 text-slate-400 hover:text-red-500 rounded shrink-0"><X className="w-4 h-4" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`w-full flex flex-col items-center justify-center gap-3 p-6 border-2 border-dashed rounded-xl transition-all cursor-pointer select-none ${smartUploadConfig.productIds.length === 0 ? 'opacity-50 cursor-not-allowed border-slate-700' : 'border-indigo-500/50 hover:border-indigo-500 bg-indigo-500/5'}`}
                    onClick={() => {
                      if (smartUploadConfig.productIds.length === 0) {
                        alert('请先搜索并选择产品');
                        return;
                      }
                      smartUploadInputRef.current?.click();
                    }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (smartUploadConfig.productIds.length === 0) return;
                      const fileList = Array.from(e.dataTransfer?.files || []);
                      if (!fileList.length) return;
                      // 在 Electron 中，从操作系统拖入的 File 带有 .path 属性；优先用真实路径走 uploadLocalPaths，以支持整个文件夹
                      const osPaths = fileList
                        .map(f => (f as any).path as string | undefined)
                        .filter(p => typeof p === 'string' && p.length > 0) as string[];
                      if (osPaths.length > 0) {
                        setSmartUploadPendingPaths(prev => [...prev, ...osPaths]);
                      } else {
                        setSmartUploadPendingFiles(prev => [...prev, ...fileList]);
                      }
                    }}
                    onDragOver={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                    }}
                  >
                    <Upload className={`w-6 h-6 ${smartUploadConfig.productIds.length === 0 ? 'text-slate-600' : 'text-indigo-500'}`} />
                    <div className="text-center">
                      <p className={`text-sm font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{(smartUploadPendingFiles.length + smartUploadPendingPaths.length) > 0 ? '点击或拖拽继续添加' : '点击或拖拽选择文件'}</p>
                      <p className="text-xs text-slate-500 mt-0.5">选择产品与分类后，点击下方「确定上传」执行</p>
                    </div>
                    <input
                      ref={smartUploadInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={e => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = '';
                        if (files.length) setSmartUploadPendingFiles(prev => [...prev, ...files]);
                      }}
                    />
                  </div>
                </div>

                {/* 上传进度 */}
                {loading && smartUploadProgress && (
                  <div className={`flex flex-col gap-2 p-3 rounded-xl border ${theme === 'dark' ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-indigo-50 border-indigo-200'}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className={`font-medium ${theme === 'dark' ? 'text-indigo-300' : 'text-indigo-700'}`}>
                        {smartUploadProgress.productIndex === 0 ? '准备中…' : `正在上传 第 ${smartUploadProgress.productIndex}/${smartUploadProgress.productTotal} 个产品`}
                      </span>
                      {smartUploadProgress.productName && <span className={`text-xs ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{smartUploadProgress.productName}</span>}
                    </div>
                    <div className="h-2 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
                      <div
                        className="h-full bg-indigo-600 transition-all duration-300"
                        style={{ width: `${smartUploadProgress.productTotal ? (smartUploadProgress.productIndex / smartUploadProgress.productTotal) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* 确定上传 */}
                {(() => {
                  const pendingCount = smartUploadPendingFiles.length + smartUploadPendingPaths.length;
                  return (
                <button
                  type="button"
                  disabled={pendingCount === 0 || loading}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const files = smartUploadPendingFilesRef.current?.length ? smartUploadPendingFilesRef.current : smartUploadPendingFiles;
                    doSmartUpload(files, smartUploadPendingPaths.length > 0 ? smartUploadPendingPaths : undefined);
                  }}
                  className={`w-full py-3 rounded-lg font-bold transition-all ${pendingCount > 0 && !loading ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-600 text-slate-400 cursor-not-allowed'} ${theme === 'dark' ? '' : ''}`}
                >
                  {loading ? '上传中…' : smartUploadConfig.productIds.length === 0 ? `确定上传 (${pendingCount} 个文件，需先选择产品)` : `确定上传 (${pendingCount} 个文件)`}
                </button>
                  );
                })()}
                </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showAddProductModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-full max-w-md max-h-[90vh] overflow-y-auto ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl shadow-2xl`}
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
              <h3 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
                {isEditingProduct ? '编辑产品' : '添加新产品'}
              </h3>
              <button 
                onClick={() => {
                  setShowAddProductModal(false);
                  setIsEditingProduct(false);
                }} 
                className="p-2 hover:bg-slate-800 rounded-full text-slate-500"
              >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="flex flex-col items-center gap-4 mb-4 flex-shrink-0">
                  <div className={`w-24 h-24 rounded-xl border-2 border-dashed ${theme === 'dark' ? 'border-slate-700 bg-slate-800' : 'border-slate-300 bg-slate-50'} flex flex-col items-center justify-center overflow-hidden relative`}>
                    {productImageFile ? (
                      <img src={URL.createObjectURL(productImageFile)} className="w-full h-full object-cover" alt="" />
                    ) : newProductForm.image_path ? (
                      <>
                        <img 
                          src={`${API_BASE}/thumbnail?path=${encodeURIComponent(String(newProductForm.image_path).replace(/\\/g, '/'))}&token=${user?.token || ''}`} 
                          className="w-full h-full object-cover" 
                          alt=""
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                          }}
                        />
                        <div className="hidden absolute inset-0 flex flex-col items-center justify-center">
                          <ImageIcon className="w-8 h-8 text-slate-500 mb-1 pointer-events-none" />
                          <span className="text-[10px] text-slate-500 pointer-events-none">上传图片</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <ImageIcon className="w-8 h-8 text-slate-500 mb-1 pointer-events-none" />
                        <span className="text-[10px] text-slate-500 pointer-events-none">上传图片</span>
                      </>
                    )}
                    <input 
                      type="file" 
                      accept="image/*"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
                      onChange={e => e.target.files?.[0] && setProductImageFile(e.target.files[0])}
                    />
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">货号 (SKU)</label>
                    <input 
                      type="text" 
                      placeholder="例如: SP-2024-001"
                      className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                      value={newProductForm.sku}
                      onChange={e => setNewProductForm({...newProductForm, sku: e.target.value})}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase">品牌</label>
                      <select 
                        className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                        value={newProductForm.brand_id || ''}
                        onChange={e => setNewProductForm({...newProductForm, brand_id: Number(e.target.value) || undefined})}
                      >
                        <option value="">选择品牌</option>
                        {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase">正式名称</label>
                      <input 
                        type="text" 
                        placeholder="例如: 抑菌四件套"
                        autoComplete="off"
                        className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                        value={newProductForm.official_name}
                        onChange={e => setNewProductForm({...newProductForm, official_name: e.target.value})}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-500 uppercase">产品别名 (逗号隔开)</label>
                    <textarea 
                      placeholder="例如: 美容枕, 护颈枕, 记忆棉枕"
                      rows={2}
                      autoComplete="off"
                      className={`w-full px-4 py-2.5 rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500 resize-none`}
                      value={newProductForm.names}
                      onChange={e => setNewProductForm({...newProductForm, names: e.target.value})}
                    />
                  </div>
                </div>
                <div className="space-y-2 px-6 pb-6">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-500 uppercase">产品规格 (SKU/颜色)</label>
                    <button 
                      onClick={() => setNewProductForm({...newProductForm, variants: [...newProductForm.variants, { sku: '', color: '' }]})}
                      className="text-[10px] text-sky-500 hover:text-sky-400 font-bold flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" /> 添加规格
                    </button>
                  </div>
                  <div className="space-y-2 max-h-32 overflow-y-auto pr-1">
                    {newProductForm.variants.map((v, i) => (
                      <div key={i} className="flex gap-2">
                        <input 
                          type="text" 
                          placeholder="SKU"
                          className={`flex-1 px-3 py-1.5 text-xs rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                          value={v.sku}
                          onChange={e => {
                            const newVariants = [...newProductForm.variants];
                            newVariants[i].sku = e.target.value;
                            setNewProductForm({...newProductForm, variants: newVariants});
                          }}
                        />
                        <input 
                          type="text" 
                          placeholder="颜色"
                          className={`w-24 px-3 py-1.5 text-xs rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                          value={v.color}
                          onChange={e => {
                            const newVariants = [...newProductForm.variants];
                            newVariants[i].color = e.target.value;
                            setNewProductForm({...newProductForm, variants: newVariants});
                          }}
                        />
                        <button 
                          onClick={() => {
                            const newVariants = newProductForm.variants.filter((_, idx) => idx !== i);
                            setNewProductForm({...newProductForm, variants: newVariants});
                          }}
                          className="p-1.5 text-slate-500 hover:text-red-500"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 px-6 pb-6 border-t border-slate-800/50 pt-4">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-500 uppercase">自动创建文件夹结构（可多级）</label>
                    {user.permissions.canManageProducts && (
                      <button
                        type="button"
                        onClick={handleSaveFolderTemplate}
                        className="text-[10px] font-bold text-sky-500 hover:text-sky-400"
                      >
                        保存为默认文件夹
                      </button>
                    )}
                  </div>
                  {selectedFolderPath.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mb-2">
                      <button
                        type="button"
                        onClick={() => setSelectedFolderPath([])}
                        className="text-[10px] font-medium text-slate-500 hover:text-indigo-500"
                      >
                        根
                      </button>
                      {selectedFolderPath.map((idx, depth) => {
                        const pathToHere = selectedFolderPath.slice(0, depth + 1);
                        const node = getProductNodeAtPath(newProductForm.folders, pathToHere);
                        return (
                          <span key={depth} className="flex items-center gap-1">
                            <span className="text-slate-500">/</span>
                            <button
                              type="button"
                              onClick={() => setSelectedFolderPath(pathToHere)}
                              className="text-[10px] font-medium text-indigo-500 hover:underline"
                            >
                              {node?.name || '?'}
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {(selectedFolderPath.length === 0 ? newProductForm.folders : (getProductNodeAtPath(newProductForm.folders, selectedFolderPath)?.children || [])).map((node, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium cursor-pointer transition-all border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200'}`}
                      >
                        <span onClick={() => setSelectedFolderPath(selectedFolderPath.length === 0 ? [i] : [...selectedFolderPath, i])}>
                          {node.name}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const nextPath = selectedFolderPath.length === 0 ? [i] : [...selectedFolderPath, i];
                            setNewProductForm({ ...newProductForm, folders: removeProductNodeAtPath(newProductForm.folders, nextPath) });
                            if (selectedFolderPath.length > 0 && selectedFolderPath[0] === nextPath[0] && nextPath.length === 1) setSelectedFolderPath([]);
                            else if (selectedFolderPath.length >= nextPath.length && selectedFolderPath.slice(0, nextPath.length).every((v, j) => v === nextPath[j])) setSelectedFolderPath(selectedFolderPath.slice(0, -1));
                          }}
                          className="hover:text-red-500 ml-0.5"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {((selectedFolderPath.length === 0 ? newProductForm.folders : (getProductNodeAtPath(newProductForm.folders, selectedFolderPath)?.children || []))).length === 0 && (
                      <span className="text-[9px] text-slate-500 italic">暂无子文件夹，可在下方添加</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder={selectedFolderPath.length === 0 ? '新建一级文件夹...' : '在当前层级下新建子文件夹...'}
                      className={`flex-1 px-3 py-1.5 text-xs rounded-lg border ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'} outline-none focus:ring-2 focus:ring-sky-500`}
                      value={newChildFolderName}
                      onChange={e => setNewChildFolderName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newChildFolderName.trim()) {
                          setNewProductForm({ ...newProductForm, folders: addProductChildAtPath(newProductForm.folders, selectedFolderPath, { name: newChildFolderName.trim(), children: [] }) });
                          setNewChildFolderName('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newChildFolderName.trim()) {
                          setNewProductForm({ ...newProductForm, folders: addProductChildAtPath(newProductForm.folders, selectedFolderPath, { name: newChildFolderName.trim(), children: [] }) });
                          setNewChildFolderName('');
                        }
                      }}
                      className="p-1.5 bg-slate-800 text-sky-500 hover:bg-slate-700 rounded-lg transition-all"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-slate-800/50 flex gap-3">
                <button 
                  onClick={handleCreateProduct}
                  className="flex-1 bg-sky-600 hover:bg-sky-500 text-white font-bold py-3 rounded-lg transition-all"
                >
                  {isEditingProduct ? '保存修改' : '确认添加'}
                </button>
                <button 
                  onClick={() => {
                    setShowAddProductModal(false);
                    setIsEditingProduct(false);
                  }}
                  className={`flex-1 ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} font-bold py-3 rounded-lg transition-all`}
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 新建文件夹弹窗 */}
      <AnimatePresence>
        {showNewFolderModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className={`w-full max-w-sm ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl p-6 shadow-2xl`}
            >
              <h3 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'} mb-4`}>新建文件夹</h3>
              <input 
                autoFocus
                type="text" 
                className={`w-full ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-900'} border rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-sky-500 mb-6 transition-all`}
                placeholder="文件夹名称"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
              />
              <div className="flex gap-3">
                <button 
                  onClick={handleCreateFolder}
                  className="flex-1 bg-sky-600 hover:bg-sky-500 text-white font-bold py-2 rounded-lg transition-all"
                >
                  创建
                </button>
                <button 
                  onClick={() => setShowNewFolderModal(false)}
                  className={`flex-1 ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} font-bold py-2 rounded-lg transition-all`}
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 打标签弹窗 */}
      <AnimatePresence>
        {showTaggingModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className={`w-full max-w-2xl ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'} border rounded-2xl p-6 shadow-2xl flex flex-col max-h-[80vh]`}
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>关联产品标签</h3>
                  <p className="text-xs text-slate-500 mt-1">为上传的 {showTaggingModal.files.length} 个文件选择所属产品</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="搜索产品..."
                      className={`w-48 ${theme === 'dark' ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-900'} border rounded-full pl-10 pr-4 py-1.5 text-sm focus:ring-2 focus:ring-sky-500 outline-none transition-all`}
                      value={taggingSearchQuery}
                      onChange={e => setTaggingSearchQuery(e.target.value)}
                    />
                  </div>
                  <button onClick={() => { setShowTaggingModal(null); setTaggingSearchQuery(''); }} className="p-2 hover:bg-slate-800 rounded-full text-slate-500">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 space-y-6">
                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase">选择产品</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {products.filter(p => {
                      const query = taggingSearchQuery.toLowerCase();
                      return p.sku.toLowerCase().includes(query) || p.names.toLowerCase().includes(query);
                    }).map(product => {
                      const isSelected = showTaggingModal.selectedProductIds.includes(product.id);
                      return (
                        <button
                          key={product.id}
                          onClick={() => {
                            const newIds = isSelected 
                              ? showTaggingModal.selectedProductIds.filter(id => id !== product.id)
                              : [...showTaggingModal.selectedProductIds, product.id];
                            // 如果取消选择产品，也取消选择该产品下的所有变体
                            let newVariantIds = showTaggingModal.selectedVariantIds;
                            if (isSelected) {
                              newVariantIds = newVariantIds.filter(vid => !product.variants?.some(v => v.id === vid));
                            }
                            setShowTaggingModal({ ...showTaggingModal, selectedProductIds: newIds, selectedVariantIds: newVariantIds });
                          }}
                          className={`p-3 rounded-xl border text-left transition-all relative ${
                            isSelected 
                              ? 'border-sky-500 bg-sky-500/10' 
                              : theme === 'dark' ? 'border-slate-800 bg-slate-800/30 hover:border-slate-700' : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                          }`}
                        >
                          {isSelected && <Check className="w-4 h-4 text-sky-500 absolute top-2 right-2" />}
                          <span className="text-[10px] font-bold text-sky-500 block mb-1">{product.sku}</span>
                          <span className={`text-xs font-medium block truncate ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}>
                            {product.names.split(',')[0]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {showTaggingModal.selectedProductIds.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-slate-500 uppercase">选择具体规格 (可选)</h4>
                    <div className="space-y-4">
                      {products.filter(p => showTaggingModal.selectedProductIds.includes(p.id)).map(product => (
                        <div key={product.id} className="space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-slate-500">{product.sku}</span>
                            <div className="h-px flex-1 bg-slate-800"></div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {product.variants?.map(variant => {
                              const isVariantSelected = showTaggingModal.selectedVariantIds.includes(variant.id);
                              return (
                                <button
                                  key={variant.id}
                                  onClick={() => {
                                    const newIds = isVariantSelected 
                                      ? showTaggingModal.selectedVariantIds.filter(id => id !== variant.id)
                                      : [...showTaggingModal.selectedVariantIds, variant.id];
                                    setShowTaggingModal({ ...showTaggingModal, selectedVariantIds: newIds });
                                  }}
                                  className={`px-3 py-1.5 rounded-lg border text-xs transition-all flex items-center gap-2 ${
                                    isVariantSelected 
                                      ? 'border-sky-500 bg-sky-500 text-white' 
                                      : theme === 'dark' ? 'border-slate-800 bg-slate-800/50 text-slate-400 hover:border-slate-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                                  }`}
                                >
                                  {variant.sku} {variant.color && `(${variant.color})`}
                                  {isVariantSelected && <Check className="w-3 h-3" />}
                                </button>
                              );
                            })}
                            {(!product.variants || product.variants.length === 0) && (
                              <span className="text-[10px] text-slate-600 italic">该产品暂无规格</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-6 pt-6 border-t border-slate-800">
                <button 
                  onClick={handleTagFiles}
                  disabled={showTaggingModal.selectedProductIds.length === 0}
                  className={`flex-1 ${showTaggingModal.selectedProductIds.length === 0 ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-sky-600 hover:bg-sky-500 text-white'} font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2`}
                >
                  <Tag className="w-4 h-4" />
                  保存标签
                </button>
                <button 
                  onClick={() => { setShowTaggingModal(null); setTaggingSearchQuery(''); }}
                  className={`flex-1 ${theme === 'dark' ? 'bg-slate-800 text-slate-400 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} font-bold py-3 rounded-lg transition-all`}
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
