import express from 'express';
import { mountRegistrationRoutes } from './user-manager/registration';
import registrationPasswords from './user-manager/registration-password.cjs';
import { allowsFolder } from './user-manager/asset-scopes.mjs';
import folderAccess from './user-manager/folder-access.cjs';
const { safeAssetPath, childFolders, validScopes } = folderAccess;
import path from 'path';
import { createHash, randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import { execFile, execSync, spawn, spawnSync } from 'child_process';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import * as xlsx from 'xlsx';
import Database from 'better-sqlite3';
import mime from 'mime-types';
import archiver from 'archiver';

const app = express();
const PORT = 43123;
const JSON_BODY_LIMIT = '50mb';
const UPLOAD_FILE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
const ASSETS_ROOT = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';
// 程序数据与产品图片统一放在网盘下此文件夹，重启后仍用同一份数据，删除不会“复活”
const APP_DATA_FOLDER_NAME = '程序图片勿动';
const APP_DATA_DIR = path.join(ASSETS_ROOT, APP_DATA_FOLDER_NAME);
const DB_PATH = process.env.DATABASE_PATH || path.join(APP_DATA_DIR, 'visualflow.db');
const USERS_JSON_PATH = path.join(APP_DATA_DIR, 'users.json');
const PRODUCT_FOLDERS_PATH = path.join(APP_DATA_DIR, 'product_folders.json');
const RELEASES_DIR = path.join(process.cwd(), 'releases');
const UPDATE_CONFIG_PATH = path.join(process.cwd(), 'update_config.json');

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

// 公网/固定地址：用于 check_update 返回的下载链接（可环境变量或 update_config.json 覆盖）
function getPublicBaseUrl(): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    if (fs.existsSync(UPDATE_CONFIG_PATH)) {
      const raw = fs.readFileSync(UPDATE_CONFIG_PATH, 'utf-8');
      const cfg = JSON.parse(raw) as { publicBaseUrl?: string };
      if (cfg.publicBaseUrl) return cfg.publicBaseUrl.replace(/\/$/, '');
    }
  } catch (_) {}
  return '';
}

function getRequestBaseUrl(req: any): string {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req?.headers?.host || '').trim();
  const proto = forwardedProto || req?.protocol || 'http';
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getUpdateInfo(req?: any): { version: string; downloadUrl: string; releaseNotes?: string; fileName?: string } {
  let version = '1.0.0';
  let fileName = 'shangpin-cloud-assets-1.0.0.zip';
  let releaseNotes: string | undefined;
  try {
    if (fs.existsSync(UPDATE_CONFIG_PATH)) {
      const raw = fs.readFileSync(UPDATE_CONFIG_PATH, 'utf-8');
      const cfg = JSON.parse(raw) as { version?: string; fileName?: string; releaseNotes?: string; publicBaseUrl?: string };
      if (cfg.version) version = cfg.version;
      if (cfg.fileName) fileName = cfg.fileName;
      if (cfg.releaseNotes) releaseNotes = cfg.releaseNotes;
    } else {
      const pkgPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
        if (pkg.version) version = pkg.version;
        fileName = `shangpin-cloud-assets-${version}.zip`;
      }
    }
  } catch (_) {}
  // 兼容旧客户端：优先返回“当前请求实际访问到的地址”作为下载地址。
  // 这样局域网客户端访问 LAN 地址时，会得到 LAN 下载链接，不会再被固定公网 IP 卡住。
  const base = getRequestBaseUrl(req) || getPublicBaseUrl();
  const releaseFile = path.join(RELEASES_DIR, fileName);
  const hasFile = fs.existsSync(releaseFile);
  const downloadUrl = base && hasFile ? `${base}/releases/${encodeURIComponent(fileName)}` : '';
  return { version, downloadUrl, releaseNotes, fileName };
}

// 确保资产目录存在
if (!fs.existsSync(ASSETS_ROOT)) {
  fs.mkdirSync(ASSETS_ROOT, { recursive: true });
}
// 确保「程序图片勿动」及子目录存在，数据与产品图均在此，便于多端同步且重启不丢
if (!fs.existsSync(APP_DATA_DIR)) {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
}
const PRODUCT_IMAGES_DIR = path.join(APP_DATA_DIR, 'product_images');
if (!fs.existsSync(PRODUCT_IMAGES_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
}
// PSD/PDF/AI 缩略图统一缓存目录（勿动），文件变更时再生成，文件删除时同步删缓存
const THUMB_CACHE_DIR = path.join(APP_DATA_DIR, 'thumbs');
const PSD_THUMB_DIR = path.join(APP_DATA_DIR, 'psd_thumbs'); // 兼容旧 PSD 缓存
if (!fs.existsSync(THUMB_CACHE_DIR)) fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
if (!fs.existsSync(PSD_THUMB_DIR)) fs.mkdirSync(PSD_THUMB_DIR, { recursive: true });

function getThumbPath(relNorm: string): string {
  const flat = encodeURIComponent(relNorm) + '.webp';
  if (flat.length <= 250) return path.join(THUMB_CACHE_DIR, flat);
  return longThumbPath(relNorm) + '.webp';
}

function longThumbPath(relNorm: string) {
  const segments = relNorm.split('/').map(s => createHash('sha256').update(s).digest('hex').slice(0, 24));
  return path.join(THUMB_CACHE_DIR, 'nested', ...segments);
}

async function cacheThumbnail(relNorm: string, buffer: Buffer) {
  const target = getThumbPath(relNorm);
  const temp = path.join(path.dirname(target), randomUUID() + '.tmp');
  try {
    if (path.dirname(target) !== THUMB_CACHE_DIR) await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temp, buffer);
    await fs.promises.rename(temp, target);
  } catch (err) {
    await fs.promises.unlink(temp).catch(() => {});
    console.warn('缩略图缓存写入失败', relNorm, err);
  }
}
async function readCachedThumbIfFresh(relNorm: string, sourceMtime: number): Promise<Buffer | null> {
  const thumbPath = getThumbPath(relNorm);
  try {
    const cached = await fs.promises.stat(thumbPath);
    if (cached.mtimeMs >= sourceMtime) return await fs.promises.readFile(thumbPath);
  } catch (_) {}
  return null;
}

const NORMAL_IMAGE_THUMB_MAX_BYTES = 120 * 1024 * 1024;
function thumbnailQueue(limit: number) {
  const waiting: Array<() => void> = [];
  let active = 0;
  return async (produce: () => Promise<Buffer>) => {
    if (active < limit) active++;
    else await new Promise<void>(resume => waiting.push(resume));
    try {
      return await produce();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Keep interactive photo previews responsive while documents and videos render.
const imageQueue = thumbnailQueue(2);
const documentQueue = thumbnailQueue(2);
const thumbnailsInFlight = new Map<string, Promise<Buffer>>();
function getOrCreateThumb(rel: string, produce: () => Promise<Buffer>, queue = documentQueue) {
  const existing = thumbnailsInFlight.get(rel);
  if (existing) return existing;
  const current = queue(produce).finally(() => thumbnailsInFlight.delete(rel));
  thumbnailsInFlight.set(rel, current);
  return current;
}

function deleteThumbForPath(relNorm: string): void {
  try {
    const p = getThumbPath(relNorm);
    if (fs.existsSync(p)) safeUnlinkOrRmdir(p, false);
  } catch (_) {}
}

async function isLikelyAiPlaceholder(buffer: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(buffer).stats();
    const channels = stats.channels || [];
    const r = channels[0]?.mean ?? 0;
    const g = channels[1]?.mean ?? 0;
    const b = channels[2]?.mean ?? 0;
    const stdev = channels.reduce((sum, ch) => sum + (ch.stdev || 0), 0);
    return r > 220 && g > 80 && g < 150 && b < 60 && stdev < 8;
  } catch (_) {
    return false;
  }
}

async function renderPdfLikeFirstPageToWebp(fullPath: string): Promise<Buffer> {
  const canvasMod = await import('canvas');
  const C = (canvasMod as any).default ?? canvasMod;
  const createCanvas = C.createCanvas;
  if (!createCanvas) throw new Error('canvas.createCanvas not available');

  const prevImage = (global as any).Image;
  const prevHTMLCanvasElement = (global as any).HTMLCanvasElement;
  try {
    if (C.Image) (global as any).Image = C.Image;
    if (C.Canvas) (global as any).HTMLCanvasElement = C.Canvas;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(fullPath));
    const doc = await pdfjs.getDocument({ data, disableWorker: true } as any).promise;
    const page = await doc.getPage(1);
    const scale = 300 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as any, viewport }).promise;
    const pngBuf = canvas.toBuffer('image/png');
    return sharp(pngBuf)
      .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } finally {
    if (prevImage !== undefined) (global as any).Image = prevImage;
    else delete (global as any).Image;
    if (prevHTMLCanvasElement !== undefined) (global as any).HTMLCanvasElement = prevHTMLCanvasElement;
    else delete (global as any).HTMLCanvasElement;
  }
}

// 支持生成缩略图的视频扩展名
const VIDEO_THUMB_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.3gp'];

// 解析 ffmpeg 二进制路径：开发与打包两种环境
// 1) 环境变量 FFMPEG_PATH（最高优先级，便于自定义）
// 2) ffmpeg-static 提供的二进制（打包后会落在 app.asar.unpacked）
// 3) 系统 PATH 中的 ffmpeg（兜底）
let ffmpegPathCache: string | null | undefined = undefined;
function resolveFfmpegPath(): string | null {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  // 1) 环境变量
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    ffmpegPathCache = fromEnv;
    return ffmpegPathCache;
  }
  // 2) ffmpeg-static
  try {
    const mod = require('ffmpeg-static');
    let p: string | null = (mod && (mod.default || mod)) || null;
    if (p && typeof p === 'string') {
      // 打包(asar)环境下二进制会被解到 app.asar.unpacked，修正路径
      if (!fs.existsSync(p) && p.includes('app.asar')) {
        const unpacked = p.replace('app.asar', 'app.asar.unpacked');
        if (fs.existsSync(unpacked)) p = unpacked;
      }
      if (p && fs.existsSync(p)) {
        ffmpegPathCache = p;
        return ffmpegPathCache;
      }
    }
  } catch (_) {}
  // 3) 系统 PATH 兜底
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout) {
      const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) {
        ffmpegPathCache = first;
        return ffmpegPathCache;
      }
    }
  } catch (_) {}
  ffmpegPathCache = null;
  return ffmpegPathCache;
}

// 用 ffmpeg 抽取视频某一帧为 PNG（Buffer）。失败返回 null。
async function extractVideoFrame(fullPath: string, seekSeconds: number): Promise<Buffer | null> {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) return null;
  const args = ['-v', 'error', '-ss', String(seekSeconds), '-i', fullPath, '-frames:v', '1',
    '-vf', 'scale=300:-1:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  return new Promise(resolve => {
    execFile(ffmpeg, args, { encoding: 'buffer', timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, frame) => resolve(!err && frame.length ? frame : null));
  });
}
// 仅当网盘下尚无数据库、且旧数据在项目根时，迁移一次，避免用旧库覆盖新库
const oldDb = path.join(process.cwd(), 'visualflow.db');
const oldUsers = path.join(process.cwd(), 'users.json');
const oldFolders = path.join(process.cwd(), 'product_folders.json');
if (!fs.existsSync(DB_PATH) && fs.existsSync(oldDb)) {
  try {
    fs.copyFileSync(oldDb, DB_PATH);
    if (fs.existsSync(oldUsers) && fs.statSync(oldUsers).isFile()) fs.copyFileSync(oldUsers, USERS_JSON_PATH);
    if (fs.existsSync(oldFolders) && fs.statSync(oldFolders).isFile()) fs.copyFileSync(oldFolders, PRODUCT_FOLDERS_PATH);
  } catch (e) {
    console.warn('Migration from old data path skipped:', e);
  }
}
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 初始化数据库
const db = new Database(DB_PATH);
db.exec('CREATE TABLE IF NOT EXISTS session_signing_key (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL)');
db.prepare('INSERT OR IGNORE INTO session_signing_key VALUES (1, ?)').run(randomBytes(32).toString('hex'));
const SECRET_KEY = (db.prepare('SELECT secret FROM session_signing_key WHERE id=1').get() as {secret: string}).secret;
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );
  
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    official_name TEXT,
    names TEXT, -- 存储为别名，逗号分隔
    brand_id INTEGER,
    image_path TEXT,
    FOREIGN KEY(brand_id) REFERENCES brands(id)
  );

  CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    sku TEXT UNIQUE,
    color TEXT,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT,
    product_id INTEGER,
    variant_id INTEGER,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(variant_id) REFERENCES product_variants(id)
  );

  CREATE TABLE IF NOT EXISTS newdev_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    barcode TEXT,
    standard TEXT,
    brand TEXT,
    spec TEXT,
    current_step_key TEXT NOT NULL,
    due_at TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS newdev_uploads (
    file_path TEXT PRIMARY KEY,
    project_id INTEGER,
    uploader TEXT,
    file_stamp TEXT NOT NULL,
    pending_delete INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS asset_folder_names (
    parent TEXT NOT NULL,
    template_name TEXT NOT NULL,
    actual_name TEXT NOT NULL,
    PRIMARY KEY(parent, template_name)
  );

  CREATE TABLE IF NOT EXISTS newdev_step_transfers (
    project_id INTEGER NOT NULL REFERENCES newdev_projects(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (project_id, step_key)
  );

  CREATE TABLE IF NOT EXISTS newdev_step_configs (
    step_key TEXT PRIMARY KEY,
    step_order INTEGER NOT NULL,
    label TEXT NOT NULL,
    duration_hours INTEGER NOT NULL DEFAULT 24,
    assignee_usernames TEXT NOT NULL DEFAULT '[]',
    assignee_positions TEXT NOT NULL DEFAULT '[]',
    escalation_hours INTEGER NOT NULL DEFAULT 4,
    escalation_usernames TEXT NOT NULL DEFAULT '[]',
    escalation_positions TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS newdev_ops_rotation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    usernames TEXT NOT NULL DEFAULT '[]',
    current_index INTEGER NOT NULL DEFAULT 0,
    week_key TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS newdev_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    project_id INTEGER,
    kind TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(username, kind, project_id)
  );
`);

// 确保 products 表有新列 (用于旧数据库升级)
const productTableInfo = db.prepare("PRAGMA table_info(products)").all() as any[];
if (!productTableInfo.some(col => col.name === 'official_name')) {
  db.exec("ALTER TABLE products ADD COLUMN official_name TEXT");
}
if (!productTableInfo.some(col => col.name === 'brand_id')) {
  db.exec("ALTER TABLE products ADD COLUMN brand_id INTEGER REFERENCES brands(id)");
}

// 确保 file_tags 表有 variant_id 列 (用于旧数据库升级)
const tableInfo = db.prepare("PRAGMA table_info(file_tags)").all() as any[];
if (!tableInfo.some(col => col.name === 'variant_id')) {
  db.exec("ALTER TABLE file_tags ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)");
}


// 预置一些示例产品
const checkProducts = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
if (checkProducts.count === 0) {
  const insertProduct = db.prepare('INSERT INTO products (sku, names, image_path) VALUES (?, ?, ?)');
  insertProduct.run('SP-001', '抑菌四件套,抑菌被套,纯棉四件套', '');
  insertProduct.run('SP-002', '真丝枕套,桑蚕丝枕头,美容枕', '');
}

// 预置默认数据库用户 (旧版本兼容用，不再作为主要用户来源)
const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)');
insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'Admin');
insertUser.run('editor', bcrypt.hashSync('editor123', 10), 'Editor');
insertUser.run('viewer', bcrypt.hashSync('viewer123', 10), 'Viewer');

// --- 基于本地 JSON 的用户与权限 ---
type UserPermissions = {
  canRename?: boolean;
  canMove?: boolean;
  folderScopes?: Partial<Record<'canUpload' | 'canDownload' | 'canDelete' | 'canMove' | 'canRename' | 'canCreateFolder' | 'canTag', 'all' | string[]>>;
  canCreateFolder?: boolean;
  canUpload: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canManageProducts: boolean;
  canManageBrands: boolean;
  canTag: boolean;
  canManageUsers?: boolean;
  canApproveRegistrations?: boolean;
  canManageNewDevelopment?: boolean;
  canSendNotification?: boolean;
};

type JsonUser = {
  passwordHash?: string;
  registrationId?: string;
  username: string;
  password: string;
  role?: string;
  permissions?: Partial<UserPermissions>;
};

type JwtUser = {
  username: string;
  role: string;
  permissions: UserPermissions;
};

// 产品默认文件夹模板：支持任意层级，children 递归；兼容旧版 subFolders（仅一层子项）
type ProductFolderTemplateItem = {
  name: string;
  children?: ProductFolderTemplateItem[];
  subFolders?: string[];
};
type TemplateFolderOperation =
  | { type: 'rename'; fromSegments: string[]; toName: string }
  | { type: 'delete'; fromSegments: string[] }
  | { type: 'move'; fromSegments: string[]; toSegments: string[] };
type ProductFolderSyncOptions = {
  deleteStrategy?: 'delete' | 'move' | 'keep';
  moveTargetSegments?: string[];
};

const DEFAULT_PRODUCT_FOLDER_TEMPLATE: ProductFolderTemplateItem[] = [
  { name: '产品图片', children: [{ name: '原图', children: [] }, { name: '主图', children: [] }, { name: '详情页', children: [] }, { name: '白底图', children: [] }, { name: 'PSD源文件', children: [] }, { name: 'SKU', children: [] }] },
  { name: '包装', children: [{ name: '定稿源文件', children: [] }] },
  { name: '视频', children: [] },
  { name: '检测报告', children: [] },
];

function ensureUsersJsonExists() {
  if (!fs.existsSync(USERS_JSON_PATH)) {
    const defaultUsers: JsonUser[] = [
      {
        username: '管理员',
        password: 'admin123',
        role: 'Admin',
        permissions: {
          canUpload: true,
          canDownload: true,
          canDelete: true,
          canManageProducts: true,
          canManageBrands: true,
          canTag: true,
        },
      },
      {
        username: '上传专员',
        password: 'uploader123',
        role: 'Uploader',
        permissions: {
          canUpload: true,
          canDownload: true,
          canDelete: false,
          canManageProducts: false,
          canManageBrands: false,
          canTag: true,
        },
      },
      {
        username: '只读',
        password: 'viewer123',
        role: 'Viewer',
        permissions: {
          canUpload: false,
          canDownload: true,
          canDelete: false,
          canManageProducts: false,
          canManageBrands: false,
          canTag: false,
        },
      },
    ];
    fs.writeFileSync(USERS_JSON_PATH, JSON.stringify(defaultUsers, null, 2), 'utf-8');
  }
}

function loadJsonUsersLegacy(): JsonUser[] {
  try {
    ensureUsersJsonExists();
    if (fs.existsSync(USERS_JSON_PATH) && !fs.statSync(USERS_JSON_PATH).isFile()) return [];
    const raw = fs.readFileSync(USERS_JSON_PATH, 'utf-8');
    // 兼容 UTF-8 BOM（某些编辑器保存会带 \uFEFF，导致 JSON.parse 失败）
    const normalized = raw.replace(/^\uFEFF/, '').trim();
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) return parsed as JsonUser[];
    return [];
  } catch (e) {
    console.error('读取 users.json 失败:', e);
    return [];
  }
}

let usersJsonCache: { mtimeMs: number; users: JsonUser[] } | null = null;

function loadJsonUsers(): JsonUser[] {
  try {
    ensureUsersJsonExists();
    const stat = fs.statSync(USERS_JSON_PATH);
    if (!stat.isFile()) return [];
    if (usersJsonCache && usersJsonCache.mtimeMs === stat.mtimeMs) return usersJsonCache.users;
    const buf = fs.readFileSync(USERS_JSON_PATH);
    const candidates = [buf.toString('utf-8'), new TextDecoder('gb18030').decode(buf)];
    for (const raw of candidates) {
      try {
        const normalized = raw.replace(/^\uFEFF/, '').trim();
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
          usersJsonCache = { mtimeMs: stat.mtimeMs, users: parsed as JsonUser[] };
          return usersJsonCache.users;
        }
      } catch (_) {}
    }
    return [];
  } catch (e) {
    console.error('read users.json failed:', e);
    return [];
  }
}

function buildPermissions(user: JsonUser | null | undefined): UserPermissions {
  const baseRole = (user?.role || 'Viewer').toLowerCase();
  const isRenXiaoyu = String(user?.username || '').trim() === '任小雨';
  const base: UserPermissions =
    baseRole === 'admin'
      ? {
          canUpload: true,
          canDownload: true,
          canDelete: true,
          canManageProducts: true,
          canManageBrands: true,
          canTag: true,
          canManageUsers: true,
          canManageNewDevelopment: true,
          canSendNotification: true,
        }
      : baseRole === 'editor'
      ? {
          canUpload: true,
          canDownload: true,
          canDelete: true,
          canManageProducts: true,
          canManageBrands: true,
          canTag: true,
          canManageUsers: false,
          canManageNewDevelopment: true,
        }
      : {
          // Viewer 或其他未知角色：默认只允许查看/下载
          canUpload: false,
          canDownload: true,
          canDelete: false,
          canManageProducts: false,
          canManageBrands: false,
          canTag: false,
          canManageUsers: false,
          canManageNewDevelopment: false,
        };
  return {
    ...base,
    canRename: user?.permissions?.canUpload ?? base.canUpload,
    canMove: user?.permissions?.canUpload ?? base.canUpload,
    canCreateFolder: baseRole === 'admin',
    canApproveRegistrations: baseRole === 'admin',
    ...(isRenXiaoyu ? { canManageUsers: true, canManageNewDevelopment: true } : {}),
    ...(user?.permissions || {}),
  };
}

function getReqPermissions(req: any): UserPermissions {
  const u = req.user as Partial<JwtUser> | undefined;
  const username = u?.username;
  // 每次从 users.json 实时读取权限，确保用户管理工具修改后立即生效（无需重新登录）
  if (username) {
    const users = loadJsonUsers();
    const user = users.find(us => String(us.username).replace(/^\uFEFF/, '').trim() === String(username).trim());
    if (user) return buildPermissions(user);
  }
  // 降级兜底：token 里有 permissions 直接用（老 token 兼容）
  if (u && u.permissions) return u.permissions;
  const role = (u?.role || 'Viewer').toLowerCase();
  return buildPermissions({ username: username || '', password: '', role });
}

function allowedAsset(perms: UserPermissions, action: string, rel: string, contentsOnly = false, productImages = false) {
  return allowsFolder(perms, action, rel, contentsOnly) && safeAssetPath(ASSETS_ROOT, rel, productImages);
}

ensureUsersJsonExists();

const NEWDEV_STEPS = [
  { key: 'initiation', label: '立项', hours: 24 },
  { key: 'selling', label: '需要检测项目', hours: 24 },
  { key: 'purchase', label: '采购审核检测项', hours: 24 },
  { key: 'opsSynthesis', label: '运营综合卖点', hours: 24 },
  { key: 'packaging', label: '包装设计/白底图', hours: 48 },
  { key: 'mainDetail', label: '主图详情页设计', hours: 48 },
  { key: 'leaderReview', label: '组长审核', hours: 12 },
  { key: 'opsReview', label: '运营审核', hours: 12 },
  { key: 'done', label: '完成', hours: 0 },
];

function nowIso() {
  return new Date().toISOString();
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(v => String(v).trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function allUsernames(): string[] {
  return loadJsonUsers().map(u => String(u.username || '').trim()).filter(Boolean);
}

function usernamesByPositions(positions: string[]): string[] {
  const wanted = new Set(positions.map(p => p.trim()).filter(Boolean));
  if (!wanted.size) return [];
  return loadJsonUsers()
    .filter(u => wanted.has(String(u.role || '').trim()))
    .map(u => String(u.username || '').trim())
    .filter(Boolean);
}

function isOpsUser(user: { username?: string; role?: string }) {
  return /运营/.test(String(user.role || '')) || /运营/.test(String(user.username || ''));
}

function isLeaderReviewUser(user: { username?: string; role?: string }) {
  return /组长|主管|leader/i.test(String(user.role || '')) || /组长|主管|leader/i.test(String(user.username || ''));
}

function opsUsernames(): string[] {
  return loadJsonUsers()
    .filter(isOpsUser)
    .map(u => String(u.username || '').trim())
    .filter(Boolean);
}

function weekKeyForDate(value: Date | string | number = new Date()) {
  const now = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(now.getTime())) return '';
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}

function currentWeekKey() {
  return weekKeyForDate();
}

function ensureOpsRotationRow() {
  const existing = db.prepare('SELECT * FROM newdev_ops_rotation WHERE id = 1').get() as any;
  if (existing) return existing;
  const usernames = opsUsernames();
  db.prepare('INSERT INTO newdev_ops_rotation (id, usernames, current_index, week_key) VALUES (1, ?, 0, ?)')
    .run(JSON.stringify(usernames), '');
  return db.prepare('SELECT * FROM newdev_ops_rotation WHERE id = 1').get() as any;
}

function getOpsRotation() {
  const row = ensureOpsRotationRow();
  let usernames = parseJsonArray(row.usernames).filter(name => opsUsernames().includes(name));
  if (!usernames.length) usernames = opsUsernames();
  let currentIndex = Math.max(0, Number(row.current_index || 0));
  const weekKey = currentWeekKey();
  if (JSON.stringify(usernames) !== JSON.stringify(parseJsonArray(row.usernames))) {
    db.prepare('UPDATE newdev_ops_rotation SET usernames = ?, current_index = ? WHERE id = 1')
      .run(JSON.stringify(usernames), usernames.length ? currentIndex % usernames.length : 0);
  }
  return {
    usernames,
    currentIndex: usernames.length ? currentIndex % usernames.length : 0,
    currentUsername: usernames.length ? usernames[currentIndex % usernames.length] : '',
    weekKey,
    lastNewProjectWeekKey: String(row.week_key || ''),
  };
}

function latestNewDevProjectWeekKey(): string {
  const row = db.prepare(`
    SELECT created_at FROM newdev_projects
    WHERE created_at IS NOT NULL AND TRIM(created_at) <> ''
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as any;
  return row?.created_at ? weekKeyForDate(String(row.created_at)) : '';
}

function lastOpsRotationProjectWeekKey(): string {
  const configured = String(getNewDevSetting('opsRotationLastProjectWeekKey', '') || '').trim();
  if (configured) return configured;
  const row = ensureOpsRotationRow();
  const stored = String(row.week_key || '').trim();
  if (stored) return stored;
  return latestNewDevProjectWeekKey();
}

function resolveOpsOwnerForNewProject(): string {
  let row = ensureOpsRotationRow();
  let usernames = parseJsonArray(row.usernames).filter(name => opsUsernames().includes(name));
  if (!usernames.length) usernames = opsUsernames();
  if (!usernames.length) return '';

  let currentIndex = Math.max(0, Number(row.current_index || 0)) % usernames.length;
  const weekKey = currentWeekKey();
  const lastProjectWeekKey = lastOpsRotationProjectWeekKey();

  if (lastProjectWeekKey && lastProjectWeekKey !== weekKey) {
    currentIndex = (currentIndex + 1) % usernames.length;
  }

  db.prepare('UPDATE newdev_ops_rotation SET usernames = ?, current_index = ?, week_key = ? WHERE id = 1')
    .run(JSON.stringify(usernames), currentIndex, weekKey);
  setNewDevSetting('opsRotationLastProjectWeekKey', weekKey);

  row = db.prepare('SELECT * FROM newdev_ops_rotation WHERE id = 1').get() as any;
  usernames = parseJsonArray(row.usernames).filter(name => opsUsernames().includes(name));
  return usernames.length ? usernames[Math.max(0, Number(row.current_index || 0)) % usernames.length] : '';
}

function getNewDevSetting<T = any>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM newdev_settings WHERE key = ?').get(key) as any;
  if (!row) return fallback;
  try {
    return JSON.parse(String(row.value_json || '')) as T;
  } catch (_) {
    return fallback;
  }
}

function setNewDevSetting(key: string, value: any) {
  db.prepare(`
    INSERT INTO newdev_settings (key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

function purchaseNotificationRecipients(): string[] {
  const configured = parseJsonArray(getNewDevSetting('purchaseNotificationUsers', []));
  if (configured.length) return configured;
  const ops = usernamesByPositions(['运营部', '运营']);
  if (ops.length) return ops;
  return opsUsernames();
}

function setOpsRotation(usernames: string[], currentIndex: number) {
  const ops = new Set(opsUsernames());
  const clean = usernames.map(name => String(name || '').trim()).filter(name => name && ops.has(name));
  db.prepare('INSERT OR REPLACE INTO newdev_ops_rotation (id, usernames, current_index, week_key) VALUES (1, ?, ?, ?)')
    .run(JSON.stringify(clean), clean.length ? Math.max(0, currentIndex) % clean.length : 0, currentWeekKey());
  return getOpsRotation();
}

function ensureNewDevStepConfigs() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO newdev_step_configs
      (step_key, step_order, label, duration_hours, assignee_usernames, assignee_positions, escalation_hours, escalation_usernames, escalation_positions)
    VALUES (?, ?, ?, ?, '[]', '[]', 4, '[]', '[]')
  `);
  NEWDEV_STEPS.forEach((step, index) => insert.run(step.key, index + 1, step.label, step.hours));
  const updateDefaultLabel = db.prepare('UPDATE newdev_step_configs SET step_order = ?, label = ? WHERE step_key = ?');
  NEWDEV_STEPS.forEach((step, index) => updateDefaultLabel.run(index + 1, step.label, step.key));
  const packaging = db.prepare('SELECT assignee_usernames, assignee_positions FROM newdev_step_configs WHERE step_key = ?').get('packaging') as any;
  if (packaging && !parseJsonArray(packaging.assignee_usernames).length && !parseJsonArray(packaging.assignee_positions).length) {
    db.prepare('UPDATE newdev_step_configs SET assignee_usernames = ? WHERE step_key = ?').run(JSON.stringify(['任小雨']), 'packaging');
  }
}

ensureNewDevStepConfigs();

let stepConfigsCache: StepConfig[] | null = null;

function getStepConfigs() {
  if (stepConfigsCache) return stepConfigsCache;
  stepConfigsCache = db.prepare('SELECT * FROM newdev_step_configs ORDER BY step_order ASC').all().map((row: any) => ({
    stepKey: row.step_key,
    stepOrder: Number(row.step_order),
    label: row.label,
    durationHours: Number(row.duration_hours || 0),
    assigneeUsernames: parseJsonArray(row.assignee_usernames),
    assigneePositions: parseJsonArray(row.assignee_positions),
    escalationHours: Number(row.escalation_hours || 4),
    escalationUsernames: parseJsonArray(row.escalation_usernames),
    escalationPositions: parseJsonArray(row.escalation_positions),
  }));
  return stepConfigsCache;
}

function getStepConfig(stepKey: string) {
  return getStepConfigs().find(s => s.stepKey === stepKey) || getStepConfigs()[0];
}

function projectOpsOwnerFromData(data: any): string {
  const ops = new Set(opsUsernames());
  const direct = String(data?.opsOwnerUsername || data?.assignedOpsUsername || '').trim();
  if (direct && ops.has(direct)) return direct;
  const candidateFields = [
    data?.sellingPointAuthors,
    data?.sellingPointEditors,
    data?.testItemAuthors,
    data?.testItemEditors,
  ];
  for (const field of candidateFields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
    for (const value of Object.values(field)) {
      const username = String(value || '').trim();
      if (username && ops.has(username)) return username;
    }
  }
  const transferredTo = String(data?.transferredTo || '').trim();
  return transferredTo && ops.has(transferredTo) ? transferredTo : '';
}

function projectOpsOwner(rowOrData: any): string {
  const data = rowOrData?.data_json !== undefined ? parseProjectData(rowOrData) : rowOrData;
  return projectOpsOwnerFromData(data);
}

function withProjectOpsOwner(data: any, username?: string): any {
  const current = projectOpsOwnerFromData(data);
  if (current) return { ...data, opsOwnerUsername: current };
  const fallback = String(username || getOpsRotation().currentUsername || '').trim();
  return fallback && opsUsernames().includes(fallback) ? { ...data, opsOwnerUsername: fallback } : data;
}

function resolveStepAssignees(stepKey: string, rowOrData?: any): string[] {
  if (stepKey === 'done') return [];
  if (rowOrData?.id) {
    const transfer = db.prepare('SELECT username FROM newdev_step_transfers WHERE project_id = ? AND step_key = ?')
      .get(rowOrData.id, stepKey) as { username: string } | undefined;
    if (transfer) return [transfer.username];
  }
  if (stepKey === 'selling' || stepKey === 'opsSynthesis' || stepKey === 'opsReview') {
    const owner = rowOrData ? projectOpsOwner(rowOrData) : '';
    if (owner) return [owner];
    const current = getOpsRotation().currentUsername;
    return current ? [current] : opsUsernames();
  }
  const cfg = getStepConfig(stepKey);
  if (!cfg) return [];
  return [...new Set([...cfg.assigneeUsernames, ...usernamesByPositions(cfg.assigneePositions)])];
}

function canOperateNewDevStep(req: any, stepKey: string, rowOrData?: any): boolean {
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const perms = getReqPermissions(req);
  if (perms.canManageNewDevelopment || canManageUsers(req)) return true;
  return !!username && resolveStepAssignees(stepKey, rowOrData).includes(username);
}

function canSupplementNewDevStep(req: any, stepKey: string, rowOrData?: any): boolean {
  if (canOperateNewDevStep(req, stepKey, rowOrData)) return true;
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  if (!username) return false;
  if ((stepKey === 'selling' || stepKey === 'opsSynthesis') && opsUsernames().includes(username)) return true;
  if (stepKey === 'leaderReview') {
    const currentUser = loadJsonUsers().find(u => String(u.username || '').trim() === username);
    return isLeaderReviewUser({ username, role: currentUser?.role || (req.user as JwtUser | undefined)?.role || '' });
  }
  return false;
}

function canReviewPurchaseSellingPoint(req: any, rowOrData?: any): boolean {
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const perms = getReqPermissions(req);
  return !!perms.canManageNewDevelopment || canManageUsers(req) || (!!username && opsUsernames().includes(username));
}

function resolveEscalationRecipients(stepKey: string): string[] {
  const cfg = getStepConfig(stepKey);
  if (!cfg) return [];
  const configured = [...cfg.escalationUsernames, ...usernamesByPositions(cfg.escalationPositions)];
  return [...new Set(configured.length ? configured : allUsernames())];
}

function addNotification(usernames: string[], title: string, message: string, projectId: number | null, kind: string) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO notifications (username, title, message, project_id, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const createdAt = nowIso();
  for (const username of [...new Set(usernames.map(u => String(u).trim()).filter(Boolean))]) {
    stmt.run(username, title, message, projectId, kind, createdAt);
  }
}

function getNextStepKey(stepKey: string): string | null {
  const configs = getStepConfigs();
  const idx = configs.findIndex(s => s.stepKey === stepKey);
  if (idx < 0 || idx >= configs.length - 1) return null;
  return configs[idx + 1].stepKey;
}

function calculateDueAt(stepKey: string) {
  const cfg = getStepConfig(stepKey);
  const hours = Number(cfg?.durationHours || 0);
  if (!hours) return null;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function projectRowToJson(row: any) {
  const data = row.data_json ? JSON.parse(row.data_json) : {};
  return {
    id: Number(row.id),
    title: row.title,
    barcode: row.barcode || '',
    standard: row.standard || '',
    brand: row.brand || '',
    spec: row.spec || '',
    currentStepKey: row.current_step_key,
    dueAt: row.due_at,
    data,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    assignees: row.completed_at ? [] : resolveStepAssignees(row.current_step_key, row),
  };
}

function parseProjectData(row: any) {
  try {
    return row?.data_json ? JSON.parse(row.data_json) : {};
  } catch (_) {
    return {};
  }
}

function normalizeProjectHistory(data: any) {
  return Array.isArray(data?.history) ? data.history : [];
}

function compactHistoryValue(value: any): any {
  if (typeof value === 'string') {
    if (/^data:/i.test(value) || value.length > 200000) return '[large value omitted]';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(compactHistoryValue);
  if (value && typeof value === 'object') {
    if ('name' in value || 'path' in value) {
      return [String((value as any).name || '').trim(), String((value as any).path || '').trim()].filter(Boolean).join(' - ') || '[file]';
    }
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'snapshot' || key === 'history') continue;
      result[key] = compactHistoryValue(item);
    }
    return result;
  }
  return value;
}

function compactProjectHistoryEntry(entry: any) {
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
}

function compactProjectData(data: any) {
  const nextData = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  if (Array.isArray(nextData.history)) {
    nextData.history = nextData.history.slice(-80).map(compactProjectHistoryEntry);
  }
  return nextData;
}

function stepLabel(stepKey: string) {
  return getStepConfig(stepKey)?.label || stepKey || '-';
}

function appendProjectHistory(data: any, entry: any) {
  const nextData = compactProjectData(data);
  const history = normalizeProjectHistory(nextData);
  nextData.history = [
    ...history.slice(-79).map(compactProjectHistoryEntry),
    compactProjectHistoryEntry({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: nowIso(),
      ...entry,
    }),
  ];
  return nextData;
}

function compactStoredNewDevProjects() {
  try {
    const rows = db.prepare('SELECT id, data_json FROM newdev_projects').all() as any[];
    const update = db.prepare('UPDATE newdev_projects SET data_json = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const row of rows) {
        const original = String(row.data_json || '{}');
        let parsed: any;
        try {
          parsed = JSON.parse(original);
        } catch (_) {
          continue;
        }
        const compact = compactProjectData(parsed);
        const next = JSON.stringify(compact);
        if (next !== original) update.run(next, Number(row.id));
      }
    });
    tx();
  } catch (e) {
    console.warn('New development history compact skipped:', e);
  }
}

compactStoredNewDevProjects();

const uploadFieldsByStep: Record<string, string[]> = {
  initiation: ['existingTestReports'],
  selling: ['testItemImages'],
  opsSynthesis: ['sellingPointImages'],
  packaging: ['packagingSourceFiles', 'packagingPreviewImages', 'whiteBackgroundImages'],
  mainDetail: ['mainDetailSourceFiles', 'skuImages', 'mainImages', 'detailImages'],
  leaderReview: ['leaderRejectImages', 'leaderRejectIssueImages'],
  opsReview: ['opsRejectImages', 'opsRejectIssueImages'],
};
function projectUploadPaths(data: any, fields = Object.values(uploadFieldsByStep).flat()): Set<string> {
  const lists = fields.flatMap(key => {
    const value = data?.[key];
    return Array.isArray(value) ? [value] : Object.values(value || {});
  });
  return new Set(lists.flatMap(list => Array.isArray(list)
    ? list.map(file => file?.path).filter(p => typeof p === 'string').map(p => p.replace(/\\/g, '/'))
    : []));
}

function uploadStamp(relative: string) {
  if (!relative.split('/').every(validAssetSegment)) return null;
  const full = path.join(ASSETS_ROOT, relative);
  try {
    if (!visibleAssetPath(full)) return null;
    const stat = fs.lstatSync(full, { bigint: true });
    return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':') : null;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Import only active attachments once. Subsequent project edits cannot grant ownership of library files.
if (!getNewDevSetting('uploadOwnershipImported', false)) {
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO newdev_uploads(file_path, project_id, file_stamp) VALUES (?, ?, ?)');
    for (const row of db.prepare('SELECT id, title, data_json FROM newdev_projects').all() as any[]) {
      const data = parseProjectData(row);
      const prefix = String(data.productFolderPath || `新品开发/${safeTemplateName(row.title)}`) + '/';
      for (const rel of projectUploadPaths(data)) {
        if (!rel.startsWith(prefix)) continue;
        const stamp = uploadStamp(rel);
        if (stamp) insert.run(rel, row.id, stamp);
      }
    }
    setNewDevSetting('uploadOwnershipImported', true);
  })();
}

function cleanPendingProjectUploads() {
  const pending = db.prepare('SELECT file_path, file_stamp FROM newdev_uploads WHERE pending_delete = 1').all() as any[];
  if (!pending.length) return;
  const active = new Set<string>();
  for (const row of db.prepare('SELECT data_json FROM newdev_projects').all()) {
    for (const rel of projectUploadPaths(parseProjectData(row))) active.add(rel.toLowerCase());
  }
  for (const entry of pending) {
    const rel = entry.file_path;
    if (active.has(rel.toLowerCase())) continue;
    try {
      if (uploadStamp(rel) === entry.file_stamp) {
        safeUnlinkSync(path.join(ASSETS_ROOT, rel));
        db.prepare('DELETE FROM file_tags WHERE file_path = ?').run(rel);
        deleteThumbForPath(rel);
        const legacyThumb = path.join(PSD_THUMB_DIR, encodeURIComponent(rel) + '.webp');
        if (fs.existsSync(legacyThumb)) safeUnlinkSync(legacyThumb);
      }
      db.prepare('DELETE FROM newdev_uploads WHERE file_path = ?').run(rel);
    } catch (err) {
      console.warn('流程附件清理失败，将重试', rel, err);
    }
  }
}
setInterval(cleanPendingProjectUploads, 30000).unref();

function conflictingAttachmentEdit(req: any, row: any, nextData: any) {
  const oldData = parseProjectData(row);
  const before = projectUploadPaths(oldData);
  const after = projectUploadPaths(nextData);
  const removed = [...before].filter(rel => !after.has(rel));
  if (removed.length) {
    const editable = projectUploadPaths(oldData, uploadFieldsByStep[row.current_step_key] || []);
    if (removed.some(rel => !editable.has(rel))) return true;
  }
  const stale = req.body.updatedAt && req.body.updatedAt !== row.updated_at;
  return stale && (removed.length || before.size !== after.size);
}

function saveProjectWithUploads(row: any, nextData: any, save: () => void) {
  const retained = projectUploadPaths(nextData);
  const removed = [...projectUploadPaths(parseProjectData(row))].filter(rel => !retained.has(rel));
  db.transaction(() => {
    save();
    const queue = db.prepare('UPDATE newdev_uploads SET pending_delete = 1 WHERE file_path = ? AND project_id = ?');
    for (const rel of removed) queue.run(rel, row.id);
  })();
  if (removed.length) cleanPendingProjectUploads();
}

function attachSellingPointAuthors(oldData: any, nextData: any, username: string) {
  const oldAuthors = oldData?.sellingPointAuthors && typeof oldData.sellingPointAuthors === 'object' ? oldData.sellingPointAuthors : {};
  const nextPoints = Array.isArray(nextData?.sellingPoints) ? nextData.sellingPoints : [];
  if (!nextPoints.length) return nextData;
  const authors: Record<string, string> = {};
  for (const point of nextPoints) {
    const text = String(point || '').trim();
    if (!text) continue;
    authors[text] = oldAuthors[text] || username;
  }
  return { ...nextData, sellingPointAuthors: authors };
}

function mergeUniqueStrings(oldList: any, nextList: any): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (item: any) => {
    const text = String(item || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(text);
  };
  for (const item of (Array.isArray(nextList) ? nextList : [])) add(item);
  for (const item of (Array.isArray(oldList) ? oldList : [])) {
    const text = String(item || '').trim();
    const key = text.toLowerCase();
    if (!key || seen.has(key)) continue;
    const looksLikeEditedSameLine = result.some(existing => {
      const existingKey = existing.toLowerCase();
      return existingKey.length >= 4 && key.length >= 4 && (existingKey.includes(key) || key.includes(existingKey));
    });
    if (!looksLikeEditedSameLine) add(text);
  }
  return result;
}

function mergeEditableStringsByIndex(oldList: any, nextList: any): string[] {
  const nextRows = Array.isArray(nextList) ? nextList.map(item => String(item || '').trim()) : [];
  return nextRows;
}

function mergeFilesByPath(oldFiles: any, nextFiles: any, limit = 3): any[] {
  if (Array.isArray(nextFiles)) return nextFiles.slice(0, limit);
  const result: any[] = [];
  const seen = new Set<string>();
  for (const file of [...(Array.isArray(oldFiles) ? oldFiles : []), ...(Array.isArray(nextFiles) ? nextFiles : [])]) {
    const key = String(file?.path || file?.name || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(file);
    if (result.length >= limit) break;
  }
  return result;
}

function mergeMapByKeys(oldMap: any, nextMap: any, keys: string[], mergeValue: (oldValue: any, nextValue: any, key?: any) => any) {
  const result: Record<string, any> = {};
  const oldObj = oldMap && typeof oldMap === 'object' && !Array.isArray(oldMap) ? oldMap : {};
  const nextObj = nextMap && typeof nextMap === 'object' && !Array.isArray(nextMap) ? nextMap : {};
  for (const key of keys) {
    result[key] = mergeValue(oldObj[key], nextObj[key], key);
  }
  return result;
}

function mergeCollaborativeNewDevData(oldData: any, nextData: any, username: string) {
  const merged = { ...oldData, ...nextData };
  const sellingPoints = mergeEditableStringsByIndex(oldData?.sellingPoints, nextData?.sellingPoints);
  const testItems = mergeEditableStringsByIndex(oldData?.testItems, nextData?.testItems);
  const referenceLinks = mergeEditableStringsByIndex(oldData?.referenceLinks, nextData?.referenceLinks);
  merged.sellingPoints = sellingPoints;
  merged.testItems = testItems;
  merged.referenceLinks = referenceLinks;
  merged.sellingPointImages = mergeMapByKeys(oldData?.sellingPointImages, nextData?.sellingPointImages, sellingPoints.filter(Boolean), mergeFilesByPath);
  merged.testItemImages = mergeMapByKeys(oldData?.testItemImages, nextData?.testItemImages, testItems.filter(Boolean), mergeFilesByPath);
  const nextSellingImages = nextData?.sellingPointImages && typeof nextData.sellingPointImages === 'object' && !Array.isArray(nextData.sellingPointImages)
    ? nextData.sellingPointImages
    : {};
  const nextTestImages = nextData?.testItemImages && typeof nextData.testItemImages === 'object' && !Array.isArray(nextData.testItemImages)
    ? nextData.testItemImages
    : {};
  for (const [key, value] of Object.entries(nextSellingImages)) {
    if (Array.isArray(value)) merged.sellingPointImages[key] = value.slice(0, 3);
  }
  for (const [key, value] of Object.entries(nextTestImages)) {
    if (Array.isArray(value)) merged.testItemImages[key] = value.slice(0, 3);
  }
  const oldAuthors = oldData?.sellingPointAuthors && typeof oldData.sellingPointAuthors === 'object' ? oldData.sellingPointAuthors : {};
  const nextAuthors = nextData?.sellingPointAuthors && typeof nextData.sellingPointAuthors === 'object' ? nextData.sellingPointAuthors : {};
  const oldEditors = oldData?.sellingPointEditors && typeof oldData.sellingPointEditors === 'object' ? oldData.sellingPointEditors : {};
  const nextEditors = nextData?.sellingPointEditors && typeof nextData.sellingPointEditors === 'object' ? nextData.sellingPointEditors : {};
  merged.sellingPointAuthors = {};
  merged.sellingPointEditors = {};
  for (const point of sellingPoints) {
    if (!point) continue;
    merged.sellingPointAuthors[point] = oldAuthors[point] || nextAuthors[point] || username;
    merged.sellingPointEditors[point] = nextEditors[point] || oldEditors[point] || username;
  }
  const oldProposalStatus = oldData?.purchaseSellingPointStatus && typeof oldData.purchaseSellingPointStatus === 'object' && !Array.isArray(oldData.purchaseSellingPointStatus)
    ? oldData.purchaseSellingPointStatus
    : {};
  const nextProposalStatus = nextData?.purchaseSellingPointStatus && typeof nextData.purchaseSellingPointStatus === 'object' && !Array.isArray(nextData.purchaseSellingPointStatus)
    ? nextData.purchaseSellingPointStatus
    : {};
  merged.purchaseSellingPointStatus = { ...nextProposalStatus, ...oldProposalStatus };
  for (const [point, status] of Object.entries(nextProposalStatus)) {
    if (status === 'reset') delete merged.purchaseSellingPointStatus[point];
  }
  const acceptedPurchasePoints = (Array.isArray(oldData?.purchaseSellingPoints) ? oldData.purchaseSellingPoints : [])
    .map((item: any) => String(item || '').trim())
    .filter((point: string) => point && merged.purchaseSellingPointStatus?.[point] === 'accepted');
  for (const point of acceptedPurchasePoints) {
    if (!merged.sellingPoints.map((item: any) => String(item || '').trim()).includes(point)) {
      merged.sellingPoints = [...merged.sellingPoints.filter((item: any) => String(item || '').trim()), point];
      merged.sellingPointAuthors[point] = oldAuthors[point] || nextAuthors[point] || username;
      merged.sellingPointEditors[point] = nextEditors[point] || oldEditors[point] || username;
    }
  }
  const oldTestAuthors = oldData?.testItemAuthors && typeof oldData.testItemAuthors === 'object' ? oldData.testItemAuthors : {};
  const nextTestAuthors = nextData?.testItemAuthors && typeof nextData.testItemAuthors === 'object' ? nextData.testItemAuthors : {};
  const oldTestEditors = oldData?.testItemEditors && typeof oldData.testItemEditors === 'object' ? oldData.testItemEditors : {};
  const nextTestEditors = nextData?.testItemEditors && typeof nextData.testItemEditors === 'object' ? nextData.testItemEditors : {};
  merged.testItemAuthors = {};
  merged.testItemEditors = {};
  for (const item of testItems) {
    if (!item) continue;
    merged.testItemAuthors[item] = oldTestAuthors[item] || nextTestAuthors[item] || username;
    merged.testItemEditors[item] = nextTestEditors[item] || oldTestEditors[item] || username;
  }
  const oldReferenceAuthors = oldData?.referenceLinkAuthors && typeof oldData.referenceLinkAuthors === 'object' ? oldData.referenceLinkAuthors : {};
  const nextReferenceAuthors = nextData?.referenceLinkAuthors && typeof nextData.referenceLinkAuthors === 'object' ? nextData.referenceLinkAuthors : {};
  const oldReferenceEditors = oldData?.referenceLinkEditors && typeof oldData.referenceLinkEditors === 'object' ? oldData.referenceLinkEditors : {};
  const nextReferenceEditors = nextData?.referenceLinkEditors && typeof nextData.referenceLinkEditors === 'object' ? nextData.referenceLinkEditors : {};
  merged.referenceLinkAuthors = {};
  merged.referenceLinkEditors = {};
  for (const link of referenceLinks) {
    if (!link) continue;
    merged.referenceLinkAuthors[link] = oldReferenceAuthors[link] || nextReferenceAuthors[link] || username;
    merged.referenceLinkEditors[link] = nextReferenceEditors[link] || oldReferenceEditors[link] || username;
  }
  return merged;
}

function mergeReviewIssueData(oldData: any, nextData: any, username: string, prefix: 'leader' | 'ops') {
  const itemField = `${prefix}RejectItems`;
  const textField = `${prefix}RejectText`;
  const imageField = `${prefix}RejectIssueImages`;
  const authorField = `${prefix}RejectIssueAuthors`;
  const editorField = `${prefix}RejectIssueEditors`;
  const merged = { ...oldData, ...nextData };
  const fallbackOld = String(oldData?.[textField] || '').trim().split(/\r?\n/).map((row: string) => row.trim()).filter(Boolean);
  const fallbackNext = String(nextData?.[textField] || '').trim().split(/\r?\n/).map((row: string) => row.trim()).filter(Boolean);
  const oldRows = Array.isArray(oldData?.[itemField]) ? oldData[itemField] : fallbackOld;
  const nextRows = Array.isArray(nextData?.[itemField]) ? nextData[itemField] : fallbackNext;
  const rows = mergeEditableStringsByIndex(oldRows, nextRows);
  merged[itemField] = rows;
  merged[textField] = rows.map((row: any) => String(row || '').trim()).filter(Boolean).join('\n');
  merged[imageField] = mergeMapByKeys(oldData?.[imageField], nextData?.[imageField], rows.filter(Boolean), mergeFilesByPath);
  const nextImages = nextData?.[imageField] && typeof nextData[imageField] === 'object' && !Array.isArray(nextData[imageField]) ? nextData[imageField] : {};
  for (const [key, value] of Object.entries(nextImages)) {
    if (Array.isArray(value)) merged[imageField][key] = value.slice(0, 3);
  }
  const oldAuthors = oldData?.[authorField] && typeof oldData[authorField] === 'object' ? oldData[authorField] : {};
  const nextAuthors = nextData?.[authorField] && typeof nextData[authorField] === 'object' ? nextData[authorField] : {};
  const oldEditors = oldData?.[editorField] && typeof oldData[editorField] === 'object' ? oldData[editorField] : {};
  const nextEditors = nextData?.[editorField] && typeof nextData[editorField] === 'object' ? nextData[editorField] : {};
  merged[authorField] = {};
  merged[editorField] = {};
  for (const row of rows) {
    const text = String(row || '').trim();
    if (!text) continue;
    merged[authorField][text] = oldAuthors[text] || nextAuthors[text] || username;
    merged[editorField][text] = nextEditors[text] || oldEditors[text] || username;
  }
  return merged;
}

function buildSellingPointAuthorChanges(oldData: any, nextData: any, username: string) {
  const oldPoints = new Set((Array.isArray(oldData?.sellingPoints) ? oldData.sellingPoints : []).map((item: any) => String(item || '').trim()).filter(Boolean));
  const nextPoints = (Array.isArray(nextData?.sellingPoints) ? nextData.sellingPoints : []).map((item: any) => String(item || '').trim()).filter(Boolean);
  return nextPoints
    .filter(point => !oldPoints.has(point))
    .map(point => ({ field: 'sellingPointAuthors', label: '新增卖点', from: '', to: `${point}（添加人：${username || '-'}）` }));
}

function buildPackagingConfirmText(data: any) {
  const sellingPoints = Array.isArray(data?.sellingPoints) ? data.sellingPoints.filter(Boolean) : [];
  const purchaseItems = Array.isArray(data?.purchaseItems) ? data.purchaseItems : [];
  const passed = purchaseItems.filter((item: any) => item?.status !== 'fail').map((item: any) => item.name).filter(Boolean);
  const fallbackTests = Array.isArray(data?.testItems) ? data.testItems.filter(Boolean) : [];
  return [
    '卖点信息：',
    sellingPoints.length ? sellingPoints.map((item: string, idx: number) => `${idx + 1}. ${item}`).join('\n') : '无',
    '',
    '确认可做检测项目：',
    (passed.length ? passed : fallbackTests).length ? (passed.length ? passed : fallbackTests).map((item: string, idx: number) => `${idx + 1}. ${item}`).join('\n') : '无',
  ].join('\n');
}

function ensureProductFromNewDev(body: any) {
  const title = String(body.title || '').trim();
  const barcode = String(body.barcode || '').trim();
  const spec = String(body.spec || '').trim();
  const alias = String(body.alias || body.names || '').trim();
  const brandId = Number(body.brandId || body.brand_id || body.data?.brandId || 0) || null;
  const sku = spec || barcode || `NEWDEV-${Date.now()}`;
  const brand = brandId ? db.prepare('SELECT id, name FROM brands WHERE id = ?').get(brandId) as any : null;
  if (!brand) throw new Error('请选择有效品牌');
  const existing = db.prepare('SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.sku = ?').get(sku) as any;
  let productId = existing?.id ? Number(existing.id) : 0;
  const productRoot = productRootForRow({ brand_name: brand.name, official_name: title, sku });
  const undo: Array<() => void> = [];
  try {
    db.transaction(() => {
      if (existing) {
        const previousFolder = relAssetPath(productRootForRow(existing));
        relocateProductFolder(existing, { brand_name: brand.name, official_name: title, sku }, undo);
        if (Array.isArray(body.data?.existingTestReports)) {
          body.data.existingTestReports = body.data.existingTestReports.map((file: any) =>
            typeof file?.path === 'string' ? { ...file, path: replaceAssetPrefix(file.path, previousFolder, relAssetPath(productRoot)) } : file);
        }
        db.prepare('UPDATE products SET official_name = ?, names = ?, brand_id = ? WHERE id = ?').run(title, alias, brandId, productId);
      } else {
        const result = db.prepare('INSERT INTO products (sku, official_name, names, brand_id, image_path) VALUES (?, ?, ?, ?, ?)')
          .run(sku, title, alias, brandId, '');
        productId = Number(result.lastInsertRowid);
      }
      createProductFolders(productRoot, loadProductFolderTemplate());
    })();
  } catch (err) {
    for (const rollback of undo.reverse()) rollback();
    throw err;
  }
  return {
    productId,
    sku,
    alias,
    brandId,
    brandName: brand?.name || '',
    productFolderPath: relAssetPath(productRoot),
  };
}

function buildProjectChanges(row: any, body: any, oldData: any, nextData: any) {
  const fields = [
    ['title', '产品名称', row.title],
    ['barcode', '条码', row.barcode || ''],
    ['standard', '执行标准', row.standard || ''],
    ['brand', '品牌', row.brand || ''],
    ['spec', '规格', row.spec || ''],
  ] as const;
  const changes: any[] = [];
  for (const [field, label, oldValue] of fields) {
    if (!(field in body)) continue;
    const nextValue = String(body[field] ?? '');
    if (String(oldValue ?? '') !== nextValue) changes.push({ field, label, from: oldValue || '', to: nextValue });
  }
  const oldNote = String(oldData?.note || '');
  const nextNote = String(nextData?.note || '');
  if (oldNote !== nextNote) changes.push({ field: 'note', label: '当前步骤备注', from: oldNote, to: nextNote });
  const dataLabels: Record<string, string> = {
    __changeUser: '修改人',
    initiationSellingPoints: '立项卖点参考',
    purchaseSellingPoints: '采购添加卖点',
    sellingPoints: '卖点信息',
    testItems: '需要检测项目',
    referenceLinks: '参考链接',
    feasibleTestItems: '可做检测项目',
    purchaseItems: '采购审核项目',
    purchaseReview: '采购审核说明',
    copywritingConfirm: '文案和检测项目确认',
    packagingSourceFiles: '包装源文件',
    packagingPreviewImages: '包装预览图',
    whiteBackgroundImages: '白底图',
    assignedDesigner: '指定设计',
    designSelfCheck: '自我审核提示词',
    mainDetailSourceFiles: '主图详情页源文件',
    skuImages: 'SKU 图',
    mainImages: '主图',
    detailImages: '详情页',
    existingTestReports: '已有检测报告',
    leaderReviewComment: '组长审核意见',
    leaderRejectItems: '组长有问题的点',
    leaderRejectIssueImages: '组长问题点图片',
    leaderRejectText: '组长退回修改内容',
    leaderRejectImages: '组长退回图片',
    opsReviewComment: '运营审核意见',
    opsRejectItems: '运营有问题的点',
    opsRejectIssueImages: '运营问题点图片',
    opsRejectText: '运营退回修改内容',
    opsRejectImages: '运营退回图片',
  };
  for (const [field, label] of Object.entries(dataLabels)) {
    if (field === '__changeUser') continue;
    const oldValue = oldData?.[field] ?? '';
    const nextValue = nextData?.[field] ?? '';
  if (JSON.stringify(oldValue) !== JSON.stringify(nextValue)) {
      changes.push({ field, label, from: oldValue, to: nextValue });
    }
  }
  changes.push(...buildSellingPointAuthorChanges(oldData, nextData, String((nextData as any)?.__changeUser || '')));
  return changes;
}

function normalizeNotificationRow(row: any) {
  const normalized = { ...row };
  const title = String(normalized.title || '');
  const message = String(normalized.message || '');
  if (!title.includes('???') && !message.includes('???')) return normalized;

  const project = normalized.project_id
    ? db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(Number(normalized.project_id)) as any
    : null;
  const projectTitle = project?.title || '';

  if (String(normalized.kind || '').startsWith('step:')) {
    const stepKey = String(normalized.kind).slice('step:'.length);
    const label = getStepConfig(stepKey)?.label || stepKey;
    normalized.title = `新品流程到你处理：${projectTitle || '未命名新品'}`;
    normalized.message = `项目进入「${label}」步骤，请及时处理。`;
  } else if (String(normalized.kind || '').startsWith('escalation:')) {
    const stepKey = String(normalized.kind).slice('escalation:'.length);
    const label = getStepConfig(stepKey)?.label || stepKey;
    normalized.title = `新品流程临近超时：${projectTitle || '未命名新品'}`;
    normalized.message = `项目「${projectTitle || '未命名新品'}」当前在「${label}」，请尽快处理。`;
  }
  return normalized;
}

function createStepNotification(projectId: number, title: string, stepKey: string) {
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(projectId) as any;
  const recipients = resolveStepAssignees(stepKey, row);
  if (!recipients.length) return;
  const label = getStepConfig(stepKey)?.label || stepKey;
  addNotification(recipients, `新品流程到你处理：${title}`, `项目进入「${label}」步骤，请及时处理。`, projectId, `step:${stepKey}`);
}

let lastEscalationScanAt = 0;

function createEscalationNotifications(force = false) {
  const scanAt = Date.now();
  if (!force && scanAt - lastEscalationScanAt < 60_000) return;
  lastEscalationScanAt = scanAt;
  const rows = db.prepare(`
    SELECT * FROM newdev_projects
    WHERE completed_at IS NULL AND due_at IS NOT NULL
  `).all() as any[];
  const now = scanAt;
  for (const row of rows) {
    const cfg = getStepConfig(row.current_step_key);
    if (!cfg) continue;
    const due = Date.parse(row.due_at);
    if (!Number.isFinite(due)) continue;
    const remainingHours = (due - now) / 36e5;
    if (remainingHours <= Number(cfg.escalationHours || 4)) {
      const recipients = resolveEscalationRecipients(row.current_step_key);
      const label = cfg.label || row.current_step_key;
      addNotification(
        recipients,
        `新品流程临近超时：${row.title}`,
        `项目「${row.title}」当前在「${label}」，剩余 ${Math.max(0, remainingHours).toFixed(1)} 小时。`,
        Number(row.id),
        `escalation:${row.current_step_key}`
      );
    }
  }
}

setTimeout(() => {
  try {
    loadJsonUsers();
    getStepConfigs();
    getOpsRotation();
    createEscalationNotifications(true);
  } catch (e) {
    console.warn('New development warmup failed:', e);
  }
}, 1000);

function normalizeFolderTemplate(items: any[]): ProductFolderTemplateItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((f: any) => ({
    name: String(f.name || '').trim() || '未命名',
    children: Array.isArray(f.children) ? normalizeFolderTemplate(f.children) : (Array.isArray(f.subFolders) ? (f.subFolders as string[]).map((s: string) => ({ name: String(s).trim() || '未命名', children: [] })) : []),
  }));
}

function validateFolderTemplateNames(items: ProductFolderTemplateItem[], parents: string[] = []): string | null {
  const siblings = new Set<string>();
  for (const item of items) {
    const name = String(item?.name || '').trim();
    const currentPath = [...parents, name || '未命名'].join('/');
    if (!name) {
      return `文件夹名称不能为空：${parents.join('/') || '根目录'}`;
    }
    if (siblings.has(name.toLowerCase())) return `同级目录名称重复：${currentPath}`;
    siblings.add(name.toLowerCase());
    if (!validAssetSegment(name)) {
      return `文件夹名称包含非法字符：${currentPath}`;
    }
    if (Array.isArray(item.children)) {
      const childError = validateFolderTemplateNames(item.children, [...parents, name]);
      if (childError) return childError;
    }
  }
  return null;
}

function loadProductFolderTemplate(): ProductFolderTemplateItem[] {
  try {
    if (fs.existsSync(PRODUCT_FOLDERS_PATH) && fs.statSync(PRODUCT_FOLDERS_PATH).isFile()) {
      const raw = fs.readFileSync(PRODUCT_FOLDERS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized = normalizeFolderTemplate(parsed);
        const validationError = validateFolderTemplateNames(normalized);
        if (validationError) {
          console.warn(`product_folders.json 无效，已使用默认模板：${validationError}`);
          return DEFAULT_PRODUCT_FOLDER_TEMPLATE;
        }
        return normalized;
      }
    }
  } catch (e) {
    console.error('读取 product_folders.json 失败:', e);
  }
  return DEFAULT_PRODUCT_FOLDER_TEMPLATE;
}

function saveProductFolderTemplate(folders: ProductFolderTemplateItem[]) {
  try {
    fs.writeFileSync(PRODUCT_FOLDERS_PATH, JSON.stringify(folders, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入 product_folders.json 失败:', e);
    throw e;
  }
}

function safeTemplateName(value: string) { return String(value || '').replace(/[/\\:*?"<>|]/g, '_').trim() || '未命名'; }
const safeTemplateSegments = (segments: any): string[] =>
  Array.isArray(segments) ? segments.map(segment => safeTemplateName(String(segment || ''))).filter(Boolean) : [];
const relAssetPath = (fullPath: string) => path.relative(ASSETS_ROOT, fullPath).replace(/\\/g, '/');

function productRootForRow(product: any) {
  const brandDir = product.brand_name ? safeTemplateName(product.brand_name) : '未分类品牌';
  const productFolderName = safeTemplateName(((product.official_name || '').trim() || product.sku || '').trim());
  return path.join(ASSETS_ROOT, generatedFolderPath([brandDir, productFolderName]));
}

function relocateProductFolder(previous: any, next: any, undo: Array<() => void>) {
  const source = productRootForRow(previous);
  const destination = productRootForRow(next);
  if (source === destination) return;
  const other = getAllProductsWithVariants().some(p => p.id !== previous.id &&
    [source.toLowerCase(), destination.toLowerCase()].includes(productRootForRow(p).toLowerCase()));
  if (other) throw new Error('目录已关联其他产品，请使用独立的产品目录名称');
  if (!fs.existsSync(source)) {
    if (fs.existsSync(destination)) throw new Error('目标产品目录已存在');
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  renameAsset(source, destination, false);
  undo.push(() => fs.renameSync(destination, source));
}

function getAllProductsWithVariants() {
  const products = db.prepare(`
    SELECT p.*, b.name as brand_name
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
  `).all() as any[];
  const variants = db.prepare('SELECT * FROM product_variants').all() as any[];
  const variantMap = new Map<number, any[]>();
  for (const v of variants) {
    const pid = Number(v.product_id);
    const arr = variantMap.get(pid);
    if (arr) arr.push(v);
    else variantMap.set(pid, [v]);
  }
  return products.map(product => ({ ...product, variants: variantMap.get(Number(product.id)) || [] }));
}

// Generated folders follow manual renames. Paths chosen directly in the library stay literal.
function generatedFolderPath(segments: string[], parent = '') {
  const lookup = db.prepare('SELECT actual_name FROM asset_folder_names WHERE parent = ? AND template_name = ?');
  for (const segment of segments) {
    if (!validAssetSegment(segment)) throw new Error('目录名称无效');
    const binding = lookup.get(parent, segment) as { actual_name: string } | undefined;
    parent = path.posix.join(parent, binding?.actual_name || segment);
  }
  return parent;
}

function replaceAssetPrefix(value: string, from: string, to: string) {
  return value === from || value.startsWith(from + '/') ? to + value.slice(from.length) : value;
}

function updateTagPathPrefix(from: string, to: string) {
  // substr compares a literal prefix, including underscores and percent signs in real filenames.
  for (const [table, column] of [['file_tags', 'file_path'], ['newdev_uploads', 'file_path'],
    ['products', 'image_path'], ['asset_folder_names', 'parent']]) {
    db.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, length(?) + 1)
      WHERE ${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/'`).run(to, from, from, from, from);
  }
  const rewrite = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if ((key === 'path' || key === 'productFolderPath') && typeof value === 'string') {
        const next = replaceAssetPrefix(value.replace(/\\/g, '/'), from, to);
        if (next !== value.replace(/\\/g, '/')) {
          obj[key] = next;
          if (key === 'path' && obj.name) obj.name = path.posix.basename(next);
        }
      } else if (key !== 'history') rewrite(value);
    }
  };
  for (const row of db.prepare('SELECT id, title, data_json FROM newdev_projects').all() as any[]) {
    const data = parseProjectData(row);
    const before = JSON.stringify(data);
    if (!data.productFolderPath) {
      const legacy = `新品开发/${safeTemplateName(row.title)}`;
      const moved = replaceAssetPrefix(legacy, from, to);
      if (moved !== legacy) data.productFolderPath = moved;
    }
    rewrite(data);
    const after = JSON.stringify(data);
    if (before !== after) db.prepare('UPDATE newdev_projects SET data_json = ?, updated_at = ? WHERE id = ?').run(after, nowIso(), row.id);
  }
  const prefix = 'manual-product-update:';
  for (const row of db.prepare("SELECT id, kind FROM notifications WHERE kind LIKE 'manual-product-update:%'").all() as any[]) {
    const [encoded, ...suffix] = row.kind.slice(prefix.length).split(':');
    let original: string;
    try { original = decodeURIComponent(encoded); } catch { continue; }
    const next = replaceAssetPrefix(original, from, to);
    if (next !== original) db.prepare('UPDATE notifications SET kind = ? WHERE id = ?')
      .run([prefix + encodeURIComponent(next), ...suffix].join(':'), row.id);
  }
  try { deleteThumbsUnderPrefix(from); } catch (_) {}
}

function renameAsset(src: string, dest: string, rememberName: boolean) {
  if (src === dest) return;
  const caseOnly = process.platform === 'win32' && src.toLowerCase() === dest.toLowerCase();
  if (fs.existsSync(dest) && !caseOnly) throw new Error('目标目录已存在同名项目');
  if (!visibleAssetPath(src) || !visibleAssetPath(dest) || fs.lstatSync(src).isSymbolicLink()) throw new Error('目录不可用');
  const isDir = fs.statSync(src).isDirectory();
  fs.renameSync(src, dest);
  try {
    db.transaction(() => {
      const from = relAssetPath(src);
      const to = relAssetPath(dest);
      updateTagPathPrefix(from, to);
      if (isDir && rememberName) {
        const parent = relAssetPath(path.dirname(src));
        const oldName = path.basename(src);
        const newName = path.basename(dest);
        db.prepare('UPDATE asset_folder_names SET actual_name = ? WHERE parent = ? AND actual_name = ?').run(newName, parent, oldName);
        db.prepare('INSERT OR IGNORE INTO asset_folder_names VALUES (?, ?, ?)').run(parent, oldName, newName);
        db.prepare('DELETE FROM asset_folder_names WHERE template_name = actual_name AND parent = ?').run(parent);
      }
    })();
  } catch (err) {
    fs.renameSync(dest, src);
    throw err;
  }
}

function deleteTagPathPrefix(rel: string) {
  db.prepare("DELETE FROM file_tags WHERE file_path = ? OR substr(file_path, 1, length(?) + 1) = ? || '/'").run(rel, rel, rel);
  try { deleteThumbsUnderPrefix(rel); } catch (_) {}
}

function uniqueFolderDest(destFull: string) {
  if (!fs.existsSync(destFull)) return destFull;
  const parent = path.dirname(destFull);
  const base = path.basename(destFull);
  let index = 1;
  let candidate = path.join(parent, `${base}(${index})`);
  while (fs.existsSync(candidate)) {
    index++;
    candidate = path.join(parent, `${base}(${index})`);
  }
  return candidate;
}

function applyTemplateOperation(productRoot: string, op: TemplateFolderOperation, options: ProductFolderSyncOptions, undo?: Array<() => void>) {
  const fromSegments = safeTemplateSegments(op.fromSegments);
  if (!fromSegments.length) return;
  const srcFull = path.join(ASSETS_ROOT, generatedFolderPath(fromSegments, relAssetPath(productRoot)));
  if (!fs.existsSync(srcFull) || !fs.statSync(srcFull).isDirectory()) return;

  if (op.type === 'rename') {
    const destFull = path.join(path.dirname(srcFull), safeTemplateName(op.toName));
    if (srcFull === destFull) return;
    renameAsset(srcFull, destFull, true);
    undo?.push(() => fs.renameSync(destFull, srcFull));
    return;
  }

  if (op.type === 'move') {
    const toSegments = safeTemplateSegments(op.toSegments);
    const targetParent = path.join(productRoot, ...toSegments);
    if (targetParent === srcFull || targetParent.startsWith(srcFull + path.sep)) return;
    fs.mkdirSync(targetParent, { recursive: true });
    const destFull = uniqueFolderDest(path.join(targetParent, path.basename(srcFull)));
    fs.renameSync(srcFull, destFull);
    updateTagPathPrefix(relAssetPath(srcFull), relAssetPath(destFull));
    return;
  }

  if (op.type === 'delete') {
    const entries = fs.readdirSync(srcFull);
    if (!entries.length) {
      safeUnlinkOrRmdir(srcFull, true);
      return;
    }
    const strategy = options.deleteStrategy || 'keep';
    if (strategy === 'delete') {
      deleteTagPathPrefix(relAssetPath(srcFull));
      safeRmSyncRecursive(srcFull);
      return;
    }
    if (strategy === 'move') {
      const target = path.join(productRoot, ...safeTemplateSegments(options.moveTargetSegments));
      if (target === srcFull || target.startsWith(srcFull + path.sep)) return;
      fs.mkdirSync(target, { recursive: true });
      for (const name of entries) {
        const childFull = path.join(srcFull, name);
        const destFull = uniqueFolderDest(path.join(target, name));
        fs.renameSync(childFull, destFull);
        updateTagPathPrefix(relAssetPath(childFull), relAssetPath(destFull));
      }
      safeUnlinkOrRmdir(srcFull, true);
    }
  }
}

function previewProductFolderSync(operations: TemplateFolderOperation[]) {
  const products = getAllProductsWithVariants();
  const deleteOps = operations.filter(op => op.type === 'delete');
  const nonEmptyDeletes: { productId: number; productName: string; path: string; itemCount: number }[] = [];
  for (const product of products) {
    const productRoot = productRootForRow(product);
    for (const op of deleteOps) {
      const srcFull = path.join(productRoot, ...safeTemplateSegments(op.fromSegments));
      if (!fs.existsSync(srcFull) || !fs.statSync(srcFull).isDirectory()) continue;
      const entries = fs.readdirSync(srcFull);
      if (entries.length) {
        nonEmptyDeletes.push({
          productId: Number(product.id),
          productName: product.official_name || product.sku || '',
          path: relAssetPath(srcFull),
          itemCount: entries.length,
        });
      }
    }
  }
  return { nonEmptyDeletes, nonEmptyDeleteCount: nonEmptyDeletes.length };
}

function syncAllExistingProductFolders(folderTemplate: ProductFolderTemplateItem[], operations: TemplateFolderOperation[] = [], options: ProductFolderSyncOptions = {}) {
  const validationError = validateFolderTemplateNames(folderTemplate);
  if (validationError) throw new Error(validationError);
  const failures: string[] = [];
  for (const product of getAllProductsWithVariants()) {
    try {
      const root = productRootForRow(product);
      for (const op of operations) applyTemplateOperation(root, op, options);
      createProductFolders(root, folderTemplate);
    } catch (err: any) {
      failures.push(`${product.official_name || product.sku}：${err.message || err}`);
    }
  }
  if (failures.length) throw new Error(failures.join('；'));
}

function runProductFolderSyncJob(jobPath: string) {
  const logPath = path.join(APP_DATA_DIR, 'product-folder-sync.log');
  const log = (message: string) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
    } catch (_) {}
  };
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as {
      folders?: ProductFolderTemplateItem[];
      operations?: TemplateFolderOperation[];
      syncOptions?: ProductFolderSyncOptions;
    };
    log(`start ${jobPath}`);
    syncAllExistingProductFolders(
      Array.isArray(job.folders) ? job.folders : loadProductFolderTemplate(),
      Array.isArray(job.operations) ? job.operations : [],
      job.syncOptions && typeof job.syncOptions === 'object' ? job.syncOptions : {}
    );
    log(`done ${jobPath}`);
    try { fs.unlinkSync(jobPath); } catch (_) {}
  } catch (err: any) {
    log(`failed ${jobPath}: ${err?.stack || err?.message || err}`);
  }
}

function queueProductFolderSyncJob(folders: ProductFolderTemplateItem[], operations: TemplateFolderOperation[], syncOptions: ProductFolderSyncOptions) {
  const jobDir = path.join(APP_DATA_DIR, 'sync_jobs');
  fs.mkdirSync(jobDir, { recursive: true });
  const jobPath = path.join(jobDir, `product-folders-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(jobPath, JSON.stringify({ folders, operations, syncOptions }, null, 2), 'utf-8');

  const entry = process.argv[1];
  if (!entry || !fs.existsSync(entry)) {
    setTimeout(() => runProductFolderSyncJob(jobPath), 5000);
    return;
  }

  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PRODUCT_FOLDER_SYNC_JOB: jobPath,
      NODE_ENV: process.env.NODE_ENV || 'production',
    },
  });
  child.unref();
}

app.use(cors());


// 静态资源：新版本 zip 下载目录（公司主机部署时使用）
if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });
app.use('/releases', express.static(RELEASES_DIR, { maxAge: 0 }));

// 版本与更新检查（无需登录，供客户端启动时静默请求）
app.get('/check_update', (req, res) => {
  const info = getUpdateInfo(req);
  res.json(info);
});

// --- 鉴权中间件 ---
const authenticate = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader && authHeader.split(' ')[1];
  const tokenFromQuery = req.query?.token as string | undefined;
  const token = tokenFromHeader || tokenFromQuery;
  
  if (!token) return res.status(401).json({ error: '未授权' });
  
  try {
    req.user = jwt.verify(token, SECRET_KEY);
    const account = loadJsonUsers().find(user => user.username.trim() === req.user.username?.trim());
    if (!account || account.registrationId !== req.user.registrationId) return res.status(401).json({ error: '账号已失效' });
    next();
  } catch (err) {
    res.status(401).json({ error: '无效的 Token' });
  }
};

mountRegistrationRoutes(app, {
  db, authenticate, canManage: canManageUsers,
  canApprove: (req: any) => !!getReqPermissions(req).canApproveRegistrations,
  loadUsers: loadJsonUsers, saveUsers: saveJsonUsers, validScopes, permissionBodyLimit: JSON_BODY_LIMIT,
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

// --- API 路由 ---

// 获取服务器配置（含局域网地址，供客户端优先使用局域网）
function getLanAddress(port: number): string | null {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      const addrs = ifaces[name];
      if (!addrs) continue;
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('127.')) {
          return `http://${a.address}:${port}`;
        }
      }
    }
  } catch (_) {}
  return null;
}

app.get('/api/config', (req, res) => {
  const server = (req as any).socket?.server;
  const port = (server?.address?.()?.port ?? Number(process.env.PORT)) || PORT;
  const lanBaseUrl = getLanAddress(port);
  const publicBaseUrl = getPublicBaseUrl();
  res.json({ lanBaseUrl, port, publicBaseUrl });
});

// 登录（基于本地 users.json）
let passwordChecks = 0;
app.post('/api/login', async (req, res, next) => {
  const { username, password } = req.body as { username: string; password: string };
  const users = loadJsonUsers();
  const inUser = String(username ?? '').replace(/^\uFEFF/, '').trim();
  const inPass = String(password ?? '').replace(/^\uFEFF/, '').trim();
  const candidates = users.filter(u => {
    const name = String(u?.username ?? '').trim();
    return u.registrationId ? name.normalize('NFKC').toLowerCase() === inUser.normalize('NFKC').toLowerCase() : name === inUser;
  });
  let user = candidates.find(u => !u.passwordHash && !!inPass && String(u.password || '').trim() === inPass);
  if (!user && inPass && inPass.length <= 128 && candidates.some(u => u.passwordHash)) {
    if (passwordChecks >= 6) return res.status(429).json({ error: '登录请求较多，请稍后再试' });
    passwordChecks++;
    try {
      for (const candidate of candidates) {
        if (candidate.passwordHash && await registrationPasswords.verifyPassword(inPass, candidate.passwordHash)) {
          user = candidate;
          break;
        }
      }
    } catch (err) { return next(err); }
    finally { passwordChecks--; }
  }

  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const permissions = buildPermissions(user);
  const jwtUser: JwtUser = {
    username: user.username,
    role: user.role || 'User',
    permissions,
  };

  const token = jwt.sign({ username: jwtUser.username, role: jwtUser.role, registrationId: user.registrationId }, SECRET_KEY, { expiresIn: '24h' });
  res.json({
    token,
    username: jwtUser.username,
    role: jwtUser.role,
    permissions: jwtUser.permissions,
  });
});

// 获取当前用户最新权限（前端每次启动时调用，确保权限与 users.json 同步，避免本地缓存滞后）
app.get('/api/me', authenticate, (req: any, res) => {
  const u = req.user as JwtUser | undefined;
  if (!u?.username) return res.status(401).json({ error: '未授权' });
  const permissions = getReqPermissions(req);
  res.json({
    username: u.username,
    role: u.role,
    permissions,
  });
});

// --- 品牌管理 API ---

function canManageUsers(req: any) {
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const perms = getReqPermissions(req);
  return username === '任小雨' || !!perms.canManageUsers;
}

function saveJsonUsers(users: JsonUser[]) {
  const temp = USERS_JSON_PATH + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(users, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, USERS_JSON_PATH);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  usersJsonCache = null;
}

app.get('/api/users/folders', authenticate, async (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权设置权限范围' });
  try { res.json(await childFolders(ASSETS_ROOT, req.query.path ?? '')); }
  catch { res.status(400).json({ error: '无法读取目录' }); }
});

app.get('/api/users', authenticate, (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  res.json(loadJsonUsers().map(u => ({
    username: u.username,
    password: u.password || '',
    protectedPassword: !!u.passwordHash,
    role: u.role || 'User',
    permissions: buildPermissions(u),
  })));
});

app.post('/api/users', authenticate, (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const body = req.body || {};
  if (!validScopes(body.permissions?.folderScopes)) return res.status(400).json({ error: '权限范围无效' });
  const username = String(body.username || '').trim();
  if (!username) return res.status(400).json({ error: '用户名不能为空' });
  const users = loadJsonUsers();
  const existingIdx = users.findIndex(u => String(u.username).trim() === username);
  const nextUser: JsonUser = {
    ...users[existingIdx],
    username,
    password: String(body.password || users[existingIdx]?.password || '123456'),
    role: String(body.role || users[existingIdx]?.role || 'User'),
    permissions: { ...users[existingIdx]?.permissions, ...body.permissions },
  };
  if (nextUser.passwordHash) {
    if (body.password) nextUser.passwordHash = registrationPasswords.resetPassword(String(body.password).trim());
    nextUser.password = '';
  }
  if (existingIdx >= 0) users[existingIdx] = nextUser;
  else users.push(nextUser);
  saveJsonUsers(users);
  res.json({ success: true });
});

app.delete('/api/users/:username', authenticate, (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const username = String(req.params.username || '').trim();
  const requester = String((req.user as JwtUser | undefined)?.username || '').trim();
  if (!username || username === requester) return res.status(400).json({ error: '不能删除当前登录账号' });
  saveJsonUsers(loadJsonUsers().filter(u => String(u.username).trim() !== username));
  res.json({ success: true });
});

app.put('/api/users', authenticate, (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const body = req.body || {};
  if (!validScopes(body.permissions?.folderScopes)) return res.status(400).json({ error: '权限范围无效' });
  const username = String(body.username || '').trim();
  if (!username) return res.status(400).json({ error: '用户名不能为空' });
  const users = loadJsonUsers();
  const existingIdx = users.findIndex(u => String(u.username).trim() === username);
  if (existingIdx < 0) return res.status(404).json({ error: '用户不存在' });
  users[existingIdx] = {
    ...users[existingIdx],
    ...(users[existingIdx].passwordHash
      ? (body.password ? { password: '', passwordHash: registrationPasswords.resetPassword(String(body.password).trim()) } : {})
      : { password: body.password ? String(body.password) : users[existingIdx].password }),
    role: String(body.role || users[existingIdx].role || 'User'),
    permissions: { ...users[existingIdx].permissions, ...body.permissions },
  };
  saveJsonUsers(users);
  res.json({ success: true });
});

app.delete('/api/users', authenticate, (req: any, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const username = String(req.query?.username || '').trim();
  const requester = String((req.user as JwtUser | undefined)?.username || '').trim();
  if (!username || username === requester) return res.status(400).json({ error: '不能删除当前登录账号' });
  saveJsonUsers(loadJsonUsers().filter(u => String(u.username).trim() !== username));
  res.json({ success: true });
});

app.get('/api/newdev/meta', authenticate, (req, res) => {
  createEscalationNotifications();
  res.json({
    steps: getStepConfigs(),
    opsRotation: getOpsRotation(),
    purchaseNotificationUsers: purchaseNotificationRecipients(),
    brands: db.prepare('SELECT * FROM brands ORDER BY name ASC').all(),
    users: loadJsonUsers().map(u => ({
      username: u.username,
      role: u.role || 'User',
      permissions: buildPermissions(u),
    })),
  });
});

app.post('/api/newdev/ops-rotation', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageNewDevelopment && !perms.canManageProducts && !perms.canUpload && !canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const usernames = parseJsonArray(req.body?.usernames);
  const currentIndex = Number(req.body?.currentIndex || 0);
  res.json({ success: true, opsRotation: setOpsRotation(usernames, currentIndex) });
});

app.post('/api/newdev/settings', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageNewDevelopment && !canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  setNewDevSetting('purchaseNotificationUsers', parseJsonArray(req.body?.purchaseNotificationUsers));
  res.json({ success: true, purchaseNotificationUsers: purchaseNotificationRecipients() });
});

app.post('/api/newdev/steps', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageNewDevelopment && !canManageUsers(req)) return res.status(403).json({ error: '无权操作' });
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const stmt = db.prepare(`
    UPDATE newdev_step_configs
    SET duration_hours = ?, assignee_usernames = ?, assignee_positions = ?,
        escalation_hours = ?, escalation_usernames = ?, escalation_positions = ?
    WHERE step_key = ?
  `);
  for (const step of steps) {
    stmt.run(
      Math.max(0, Number(step.durationHours || 0)),
      JSON.stringify(parseJsonArray(step.assigneeUsernames)),
      JSON.stringify(parseJsonArray(step.assigneePositions)),
      Math.max(0, Number(step.escalationHours || 0)),
      JSON.stringify(parseJsonArray(step.escalationUsernames)),
      JSON.stringify(parseJsonArray(step.escalationPositions)),
      String(step.stepKey || '')
    );
  }
  stepConfigsCache = null;
  res.json({ success: true, steps: getStepConfigs() });
});

app.get('/api/newdev/projects', authenticate, (req, res) => {
  createEscalationNotifications();
  const rows = db.prepare('SELECT * FROM newdev_projects ORDER BY completed_at IS NOT NULL ASC, updated_at DESC').all() as any[];
  res.json(rows.map(projectRowToJson));
});

app.get('/api/newdev/projects/sync-state', authenticate, (req, res) => {
  const rows = db.prepare(`
    SELECT id, current_step_key, updated_at, completed_at
    FROM newdev_projects
    ORDER BY completed_at IS NOT NULL ASC, updated_at DESC
  `).all() as any[];
  res.json(rows.map(row => ({
    id: Number(row.id),
    currentStepKey: row.current_step_key,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  })));
});

app.post('/api/newdev/projects', authenticate, (req: any, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: '产品名称不能为空' });
  const barcode = String(body.barcode || '').trim();
  const createdBy = String((req.user as JwtUser | undefined)?.username || '').trim();
  const duplicateSince = new Date(Date.now() - 30000).toISOString();
  const duplicate = db.prepare(`
    SELECT * FROM newdev_projects
    WHERE title = ? AND COALESCE(barcode, '') = ? AND COALESCE(created_by, '') = ? AND created_at >= ?
    ORDER BY id DESC LIMIT 1
  `).get(title, barcode, createdBy, duplicateSince) as any;
  if (duplicate) return res.json(projectRowToJson(duplicate));
  const createdAt = nowIso();
  const creationStepKey = 'initiation';
  const stepKey = 'selling';
  let linkedProduct: any;
  try {
    linkedProduct = ensureProductFromNewDev(body);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || '创建产品资料失败' });
  }
  const opsOwnerUsername = resolveOpsOwnerForNewProject();
  const initialData = compactProjectData(withProjectOpsOwner({ ...(body.data || {}), ...linkedProduct }, opsOwnerUsername));
  const data = appendProjectHistory(initialData, {
    user: createdBy,
    stepKey: creationStepKey,
    stepLabel: stepLabel(creationStepKey),
    action: 'create',
    summary: `创建新品项目，并进入${stepLabel(stepKey)}`,
    changes: [
      { field: 'title', label: '产品名称', from: '', to: title },
      ...(barcode ? [{ field: 'barcode', label: '条码', from: '', to: barcode }] : []),
      ...(body.standard ? [{ field: 'standard', label: '执行标准', from: '', to: String(body.standard || '') }] : []),
      ...(body.brand ? [{ field: 'brand', label: '品牌', from: '', to: String(body.brand || '') }] : []),
      ...(body.spec ? [{ field: 'spec', label: '货号', from: '', to: String(body.spec || '') }] : []),
      ...(Array.isArray(initialData.initiationSellingPoints) && initialData.initiationSellingPoints.some((item: any) => String(item || '').trim())
        ? [{ field: 'initiationSellingPoints', label: '立项卖点参考', from: '', to: initialData.initiationSellingPoints }]
        : []),
      ...(Array.isArray(initialData.purchaseSellingPoints) && initialData.purchaseSellingPoints.some((item: any) => String(item || '').trim())
        ? [{ field: 'purchaseSellingPoints', label: '采购添加卖点', from: '', to: initialData.purchaseSellingPoints }]
        : []),
      ...(Array.isArray(initialData.existingTestReports) && initialData.existingTestReports.length
        ? [{ field: 'existingTestReports', label: '已有检测报告', from: '', to: initialData.existingTestReports }]
        : []),
    ],
  });
  const result = db.prepare(`
    INSERT INTO newdev_projects
      (title, barcode, standard, brand, spec, current_step_key, due_at, data_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, barcode, String(body.standard || ''), String(linkedProduct.brandName || body.brand || ''), String(body.spec || ''), stepKey, calculateDueAt(stepKey), JSON.stringify(data), createdBy, createdAt, createdAt);
  const id = Number(result.lastInsertRowid);
  for (const rel of projectUploadPaths(data)) {
    db.prepare('UPDATE newdev_uploads SET project_id = ? WHERE file_path = ? AND project_id IS NULL AND uploader = ?')
      .run(id, rel, createdBy);
  }
  addNotification(allUsernames(), `新建新品项目：${title}`, `新品「${title}」已创建，所有人可查看进度。`, id, 'new-project');
  createStepNotification(id, title, stepKey);
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.delete('/api/newdev/projects/:id', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const canDeleteNewDev = username === '任小雨' || !!perms.canManageNewDevelopment || !!perms.canManageUsers || allowsFolder(perms, 'canDelete', '') || canManageUsers(req);
  if (!canDeleteNewDev) return res.status(403).json({ error: '无权删除新品记录' });
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM notifications WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM newdev_projects WHERE id = ?').run(id);
    });
    tx();
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '删除新品记录失败' });
  }
});

app.put('/api/newdev/projects/:id', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (row.completed_at) return res.status(400).json({ error: '项目已完成，不能再修改' });
  if (!canSupplementNewDevStep(req, row.current_step_key, row)) return res.status(403).json({ error: '只能修改当前由你负责的步骤' });
  const body = req.body || {};
  const oldData = parseProjectData(row);
  if (oldData.productFolderPath && req.body?.data?.productFolderPath &&
      req.body.data.productFolderPath !== oldData.productFolderPath) {
    return res.status(409).json({ error: '产品目录已变更，请刷新后重试' });
  }
  let nextData = body.data && typeof body.data === 'object' ? { ...oldData, ...compactProjectData(body.data) } : oldData;
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  if (row.current_step_key === 'selling' || row.current_step_key === 'opsSynthesis') {
    nextData = mergeCollaborativeNewDevData(oldData, nextData, username);
  } else if (row.current_step_key === 'leaderReview') {
    nextData = mergeReviewIssueData(oldData, nextData, username, 'leader');
  } else if (row.current_step_key === 'opsReview') {
    nextData = mergeReviewIssueData(oldData, nextData, username, 'ops');
  }
  if (row.current_step_key === 'selling' || row.current_step_key === 'opsSynthesis' || row.current_step_key === 'opsReview') {
    nextData = withProjectOpsOwner(nextData, username);
  }
  nextData = attachSellingPointAuthors(oldData, nextData, username);
  const changes = buildProjectChanges(row, body, oldData, { ...nextData, __changeUser: username });
  if (changes.length) {
    nextData = appendProjectHistory(nextData, {
      user: username,
      stepKey: row.current_step_key,
      stepLabel: stepLabel(row.current_step_key),
      action: 'update',
      summary: `修改了${changes.map(c => c.label).join('、')}`,
      changes,
    });
  }
  if (conflictingAttachmentEdit(req, row, nextData)) return res.status(409).json({ error: '流程附件已更新，请刷新后重试' });
  saveProjectWithUploads(row, nextData, () => {
    db.prepare('UPDATE newdev_projects SET title = ?, barcode = ?, standard = ?, brand = ?, spec = ?, data_json = ?, updated_at = ? WHERE id = ?')
      .run(String(body.title ?? row.title), String(body.barcode ?? row.barcode ?? ''), String(body.standard ?? row.standard ?? ''), String(body.brand ?? row.brand ?? ''), String(body.spec ?? row.spec ?? ''), JSON.stringify(compactProjectData(nextData)), nowIso(), id);
  });
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.post('/api/newdev/projects/:id/purchase-selling-point', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (row.completed_at) return res.status(400).json({ error: '项目已完成，不能再修改' });
  if (!canReviewPurchaseSellingPoint(req, row)) return res.status(403).json({ error: '只有运营或管理员可以处理采购卖点' });
  const point = String(req.body?.point || '').trim();
  const decision = String(req.body?.decision || '').trim();
  if (!point) return res.status(400).json({ error: '卖点不能为空' });
  if (!['accepted', 'rejected', 'reset'].includes(decision)) return res.status(400).json({ error: '处理结果无效' });
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const oldData = parseProjectData(row);
  const status = oldData.purchaseSellingPointStatus && typeof oldData.purchaseSellingPointStatus === 'object' && !Array.isArray(oldData.purchaseSellingPointStatus)
    ? { ...oldData.purchaseSellingPointStatus }
    : {};
  let nextStatus: any = { ...status, [point]: decision };
  if (decision === 'reset') {
    nextStatus = { ...status };
    delete nextStatus[point];
  }
  let nextData: any = withProjectOpsOwner({ ...oldData, purchaseSellingPointStatus: nextStatus }, username);
  if (decision === 'accepted') {
    const currentPoints = Array.isArray(nextData.sellingPoints) ? nextData.sellingPoints.map((item: any) => String(item || '')) : [];
    if (!currentPoints.map((item: string) => item.trim()).includes(point)) nextData.sellingPoints = [...currentPoints.filter((item: string) => item.trim()), point];
    nextData.sellingPointAuthors = { ...(nextData.sellingPointAuthors || {}), [point]: nextData.sellingPointAuthors?.[point] || username };
    nextData.sellingPointEditors = { ...(nextData.sellingPointEditors || {}), [point]: username };
  } else if (decision === 'reset') {
    nextData.sellingPoints = (Array.isArray(nextData.sellingPoints) ? nextData.sellingPoints : []).filter((item: any) => String(item || '').trim() !== point);
    nextData.sellingPointAuthors = { ...(nextData.sellingPointAuthors || {}) };
    nextData.sellingPointEditors = { ...(nextData.sellingPointEditors || {}) };
    nextData.sellingPointImages = { ...(nextData.sellingPointImages || {}) };
    delete nextData.sellingPointAuthors[point];
    delete nextData.sellingPointEditors[point];
    delete nextData.sellingPointImages[point];
  }
  nextData = appendProjectHistory(compactProjectData(nextData), {
    user: username,
    stepKey: row.current_step_key,
    stepLabel: stepLabel(row.current_step_key),
    action: decision === 'accepted' ? 'accept-purchase-selling-point' : decision === 'reset' ? 'reset-purchase-selling-point' : 'reject-purchase-selling-point',
    summary: `${decision === 'accepted' ? '采纳' : decision === 'reset' ? '取消采纳' : '不采纳'}采购卖点：${point}`,
    changes: [{ field: 'purchaseSellingPoints', label: '采购添加卖点', from: point, to: decision === 'accepted' ? '已采纳并复制到运营卖点' : decision === 'reset' ? '已取消采纳并从运营卖点删除' : '不采纳' }],
  });
  saveProjectWithUploads(row, nextData, () => {
    db.prepare('UPDATE newdev_projects SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(compactProjectData(nextData)), nowIso(), id);
  });
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.post('/api/newdev/projects/:id/advance', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (row.completed_at) return res.status(400).json({ error: '项目已完成' });
  if (!canOperateNewDevStep(req, row.current_step_key, row)) return res.status(403).json({ error: '只能提交当前由你负责的步骤' });
  const next = getNextStepKey(row.current_step_key);
  if (req.body?.stepKey && req.body.stepKey !== next) return res.status(409).json({ error: '流程步骤已变化，请刷新后重新提交' });
  if (!next) return res.status(400).json({ error: '已经没有下一步' });
  const done = next === 'done';
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const oldData = parseProjectData(row);
  if (oldData.productFolderPath && req.body?.data?.productFolderPath &&
      req.body.data.productFolderPath !== oldData.productFolderPath) {
    return res.status(409).json({ error: '产品目录已变更，请刷新后重试' });
  }
  const requestData = req.body?.data && typeof req.body.data === 'object' ? { ...oldData, ...compactProjectData(req.body.data) } : oldData;
  const dataForNextStep = next === 'packaging' && !requestData.copywritingConfirm
    ? { ...requestData, copywritingConfirm: buildPackagingConfirmText(requestData) }
    : requestData;
  const ownedDataForNextStep = withProjectOpsOwner(dataForNextStep, username);
  const changes = buildProjectChanges(row, {}, oldData, { ...ownedDataForNextStep, __changeUser: username });
  const nextData = appendProjectHistory(ownedDataForNextStep, {
    user: username,
    stepKey: row.current_step_key,
    stepLabel: stepLabel(row.current_step_key),
    action: done ? 'complete' : 'advance',
    summary: done ? '完成新品开发' : `提交到下一步：${stepLabel(row.current_step_key)} → ${stepLabel(next)}`,
    changes,
  });
  if (conflictingAttachmentEdit(req, row, nextData)) return res.status(409).json({ error: '流程附件已更新，请刷新后重试' });
  saveProjectWithUploads(row, nextData, () => {
    db.prepare('UPDATE newdev_projects SET current_step_key = ?, due_at = ?, data_json = ?, updated_at = ?, completed_at = ? WHERE id = ?')
      .run(next, done ? null : calculateDueAt(next), JSON.stringify(compactProjectData(nextData)), nowIso(), done ? nowIso() : null, id);
  });
  if (!done) createStepNotification(id, row.title, next);
  if (row.current_step_key === 'purchase' && req.body?.notifyOperations) {
    const summary = String(req.body?.purchaseSummary || '').trim();
    const opsUsers = purchaseNotificationRecipients();
    addNotification(
      opsUsers,
      `采购审核已完成：${row.title}`,
      summary ? `项目「${row.title}」采购审核结果如下：\n${summary}` : `项目「${row.title}」采购审核已完成。`,
      id,
      `purchase-summary:${id}:${Date.now()}`
    );
  }
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.post('/api/newdev/projects/:id/reject', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (row.completed_at) return res.status(400).json({ error: '项目已完成' });
  if (!canOperateNewDevStep(req, row.current_step_key, row)) return res.status(403).json({ error: '只能退回当前由你负责的步骤' });
  if (!['leaderReview', 'opsReview'].includes(String(row.current_step_key))) return res.status(400).json({ error: '当前步骤不能退回' });
  const targetStepKey = String(req.body?.targetStepKey || 'mainDetail');
  if (targetStepKey !== 'mainDetail') return res.status(400).json({ error: '只能退回到主图详情页设计' });
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const oldData = parseProjectData(row);
  if (oldData.productFolderPath && req.body?.data?.productFolderPath &&
      req.body.data.productFolderPath !== oldData.productFolderPath) {
    return res.status(409).json({ error: '产品目录已变更，请刷新后重试' });
  }
  const requestData = req.body?.data && typeof req.body.data === 'object' ? { ...oldData, ...compactProjectData(req.body.data) } : oldData;
  const ownedRequestData = withProjectOpsOwner(requestData, username);
  const changes = buildProjectChanges(row, {}, oldData, ownedRequestData);
  const nextData = appendProjectHistory(ownedRequestData, {
    user: username,
    stepKey: row.current_step_key,
    stepLabel: stepLabel(row.current_step_key),
    action: 'reject',
    summary: `${stepLabel(row.current_step_key)}退回到${stepLabel(targetStepKey)}修改`,
    changes,
  });
  const retained = projectUploadPaths(nextData);
  if (conflictingAttachmentEdit(req, row, nextData) || [...projectUploadPaths(oldData)].some(rel => !retained.has(rel))) {
    return res.status(409).json({ error: '附件有未同步的修改，请先保存或刷新后再退回' });
  }
  db.prepare('UPDATE newdev_projects SET current_step_key = ?, due_at = ?, data_json = ?, updated_at = ? WHERE id = ?')
    .run(targetStepKey, calculateDueAt(targetStepKey), JSON.stringify(compactProjectData(nextData)), nowIso(), id);
  createStepNotification(id, row.title, targetStepKey);
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.post('/api/newdev/projects/:id/rollback', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const perms = getReqPermissions(req);
  const canRollback = username === '任小雨' || !!perms.canManageNewDevelopment || canManageUsers(req);
  if (!canRollback) return res.status(403).json({ error: '只有管理员可以手动回退进度' });

  const targetStepKey = String(req.body?.targetStepKey || '').trim();
  const targetStep = getStepConfigs().find(step => step.stepKey === targetStepKey);
  if (!targetStep || targetStep.stepKey === 'done') return res.status(400).json({ error: '请选择有效的回退步骤' });
  if (!row.completed_at && targetStep.stepKey === row.current_step_key) return res.status(400).json({ error: '当前已经在这个步骤' });

  const oldData = parseProjectData(row);
  const nextData = appendProjectHistory(oldData, {
    user: username,
    stepKey: row.current_step_key,
    stepLabel: stepLabel(row.current_step_key),
    action: 'rollback',
    summary: `管理员手动回退进度：${stepLabel(row.current_step_key)} → ${stepLabel(targetStep.stepKey)}`,
    changes: [],
  });
  db.prepare('UPDATE newdev_projects SET current_step_key = ?, due_at = ?, data_json = ?, updated_at = ?, completed_at = NULL WHERE id = ?')
    .run(targetStep.stepKey, calculateDueAt(targetStep.stepKey), JSON.stringify(compactProjectData(nextData)), nowIso(), id);
  createStepNotification(id, row.title, targetStep.stepKey);
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.post('/api/newdev/projects/:id/broadcast', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (!canOperateNewDevStep(req, row.current_step_key, row)) return res.status(403).json({ error: '无权操作' });
  const title = String(req.body?.title || `新品流程通知：${row.title}`).trim();
  const message = String(req.body?.message || '').trim();
  addNotification(allUsernames(), title, message || title, id, `newdev-broadcast:${id}:${Date.now()}`);
  res.json({ success: true });
});

app.post('/api/newdev/projects/:id/transfer', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  if (row.completed_at) return res.status(400).json({ error: '已完成的项目不能转交' });
  if (!canOperateNewDevStep(req, row.current_step_key, row)) return res.status(403).json({ error: '无权操作' });
  const assignee = String(req.body?.assignee || '').trim();
  if (!assignee) return res.status(400).json({ error: '请选择转交人员' });
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const oldData = parseProjectData(row);
  const cfg = getStepConfig(row.current_step_key);
  const isOpsStep = row.current_step_key === 'selling' || row.current_step_key === 'opsSynthesis' || row.current_step_key === 'opsReview';
  if (!allUsernames().includes(assignee)) return res.status(400).json({ error: '转交人员不存在' });
  const transferredData = compactProjectData({ ...oldData, transferredTo: assignee, ...(isOpsStep ? { opsOwnerUsername: assignee } : {}) });
  const nextData = appendProjectHistory(transferredData, {
    user: username,
    stepKey: row.current_step_key,
    stepLabel: cfg?.label || row.current_step_key,
    action: 'transfer',
    summary: `转交给 ${assignee}`,
    changes: [{ field: 'assignee', label: '负责人', from: resolveStepAssignees(row.current_step_key, row).join('、'), to: assignee }],
  });
  db.transaction(() => {
    if (!isOpsStep) {
      db.prepare('INSERT OR REPLACE INTO newdev_step_transfers (project_id, step_key, username) VALUES (?, ?, ?)')
        .run(id, row.current_step_key, assignee);
    }
    db.prepare('UPDATE newdev_projects SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(compactProjectData(nextData)), nowIso(), id);
  })();
  createStepNotification(id, row.title, row.current_step_key);
  res.json(projectRowToJson(db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(id)));
});

app.get('/api/notifications', authenticate, (req: any, res) => {
  createEscalationNotifications();
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  const rows = db.prepare('SELECT * FROM notifications WHERE username = ? AND read_at IS NULL ORDER BY created_at DESC').all(username);
  res.json(rows.map((row: any) => {
    const normalized = normalizeNotificationRow(row);
    if (normalized.project_id && !String(normalized.kind || '').startsWith('manual-product-update:')) {
      const project = db.prepare('SELECT data_json FROM newdev_projects WHERE id = ?').get(Number(normalized.project_id)) as any;
      const data = project ? parseProjectData(project) : {};
      const folderPath = String(data?.productFolderPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/').trim();
      if (folderPath) normalized.productFolderPath = folderPath;
    }
    return normalized;
  }));
});

app.post('/api/notifications/:id/read', authenticate, (req: any, res) => {
  const username = String((req.user as JwtUser | undefined)?.username || '').trim();
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND username = ?').run(nowIso(), Number(req.params.id), username);
  res.json({ success: true });
});

app.get('/api/notification-recipients', authenticate, (req, res) => {
  res.json(loadJsonUsers().map(u => ({
    username: String(u.username || '').trim(),
    role: String(u.role || '未分部门').trim() || '未分部门',
  })).filter(u => u.username));
});

app.post('/api/manual-notification', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canSendNotification && !canManageUsers(req)) {
    return res.status(403).json({ error: '无权操作' });
  }
  const body = req.body || {};
  const selectedUsers = parseJsonArray(body.usernames).map(v => String(v || '').trim()).filter(Boolean);
  const selectedDepartments = parseJsonArray(body.departments).map(v => String(v || '').trim()).filter(Boolean);
  const recipients = [...new Set([
    ...selectedUsers,
    ...usernamesByPositions(selectedDepartments),
  ].map(v => String(v).trim()).filter(Boolean))];
  if (!recipients.length) {
    return res.status(400).json({
      error: '请选择通知对象',
      details: `users=${selectedUsers.length}, departments=${selectedDepartments.length}, resolvedRecipients=0`,
    });
  }

  const sender = String((req.user as JwtUser | undefined)?.username || '').trim();
  const title = String(body.title || '').trim() || '系统通知';
  const messageBody = String(body.message || '').trim();
  const productUpdate = !!body.productUpdate;
  const productFolderPath = String(body.productFolderPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/').trim();
  if (productUpdate && !productFolderPath) return res.status(400).json({ error: '请选择更新的产品' });
  const productName = String(body.productName || '').trim();
  const message = [
    `发布人：${sender || '-'}`,
    productUpdate && productName ? `更新产品：${productName}` : '',
    messageBody
  ].filter(Boolean).join('\n');
  const kind = productUpdate
    ? `manual-product-update:${encodeURIComponent(productFolderPath)}:${Date.now()}`
    : `manual:${Date.now()}`;
  addNotification(recipients, title, message, null, kind);
  res.json({ success: true, count: recipients.length, details: `users=${selectedUsers.length}, departments=${selectedDepartments.length}` });
});

app.post('/api/products/:id/image-update-notification', authenticate, (req: any, res) => {
  const id = Number(req.params.id);
  const product = db.prepare(`
    SELECT p.*, b.name AS brand_name
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
    WHERE p.id = ?
  `).get(id) as any;
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const body = req.body || {};
  const selectedUsers = parseJsonArray(body.usernames);
  const selectedDepartments = parseJsonArray(body.departments);
  const recipients = [...new Set([
    ...selectedUsers,
    ...usernamesByPositions(selectedDepartments),
  ].map(v => String(v).trim()).filter(Boolean))];
  if (!recipients.length) return res.status(400).json({ error: '请选择通知对象' });

  const sender = String((req.user as JwtUser | undefined)?.username || '').trim();
  const productName = product.official_name || product.sku || `产品 ${id}`;
  const note = String(body.message || '').trim();
  const title = `产品图片已更新：${productName}`;
  const message = [
    `${sender || '设计'} 已替换产品图片，请及时更新使用中的图片。`,
    product.brand_name ? `品牌：${product.brand_name}` : '',
    product.sku ? `货号：${product.sku}` : '',
    note ? `说明：${note}` : '',
  ].filter(Boolean).join('\n');
  addNotification(recipients, title, message, null, `product-image-update:${id}`);
  res.json({ success: true, count: recipients.length });
});

app.get('/api/brands', authenticate, (req, res) => {
  const brands = db.prepare('SELECT * FROM brands').all();
  res.json(brands);
});

app.post('/api/brands', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageBrands) return res.status(403).json({ error: '无权操作' });
  const { name } = req.body;
  try {
    db.prepare('INSERT INTO brands (name) VALUES (?)').run(name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || '操作失败' });
  }
});

app.delete('/api/brands/:id', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!allowsFolder(perms, 'canDelete', '') || !perms.canManageBrands) return res.status(403).json({ error: '无权操作' });
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: '删除失败，可能有关联产品' });
  }
});

// --- 产品管理 API ---

// 获取所有产品及其变体
app.get('/api/products', authenticate, (req, res) => {
  const productsWithVariants = getAllProductsWithVariants().map(p => ({
    ...p, productFolderPath: relAssetPath(productRootForRow(p))
  }));
  res.json(productsWithVariants);
});

const CATEGORIES = ['产品图片', '检测报告', '视频'];

// 获取/设置产品默认文件夹模板
app.get('/api/product-folders/template', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageProducts) return res.status(403).json({ error: '无权操作' });
  const tmpl = loadProductFolderTemplate();
  res.json(tmpl);
});

app.post('/api/product-folders/sync-preview', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageProducts) return res.status(403).json({ error: '无权操作' });
  const operations = Array.isArray(req.body?.operations) ? req.body.operations as TemplateFolderOperation[] : [];
  try {
    res.json(previewProductFolderSync(operations));
  } catch (err: any) {
    res.status(500).json({ error: err.message || '同步预览失败' });
  }
});

app.post('/api/product-folders/template', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageProducts) return res.status(403).json({ error: '无权操作' });
  try {
    const { folders, operations, syncOptions } = req.body as { folders: ProductFolderTemplateItem[]; operations?: TemplateFolderOperation[]; syncOptions?: ProductFolderSyncOptions };
    if (!Array.isArray(folders)) {
      return res.status(400).json({ error: 'folders 格式错误，必须为数组' });
    }
    const normalizedFolders = normalizeFolderTemplate(folders);
    const validationError = validateFolderTemplateNames(normalizedFolders);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    saveProductFolderTemplate(normalizedFolders);
    const normalizedOps = Array.isArray(operations) ? operations : [];
    const normalizedOptions = syncOptions && typeof syncOptions === 'object' ? syncOptions : {};
    queueProductFolderSyncJob(normalizedFolders, normalizedOps, normalizedOptions);
    res.json({ success: true, syncingExistingFolders: true });
  } catch (err: any) {
    console.error('保存默认文件夹模板失败:', err);
    res.status(500).json({ error: `保存默认文件夹模板失败：${err?.message || '服务器内部错误'}` });
  }
});

// 辅助函数：创建产品目录结构（以产品正式名称命名，非编码）
function createProductFolders(productDir: string, folderConfig: any[]) {
  const createDirsRecursive = (basePath: string, items: any[]) => {
    if (!Array.isArray(items)) return;
    for (const cat of items) {
      if (!cat) continue;
      const catName = typeof cat === 'string' ? cat : (cat.name || '');
      const name = safeTemplateName(catName);
      if (!name) continue;
      const catPath = path.join(ASSETS_ROOT, generatedFolderPath([name], relAssetPath(basePath)));
      if (!fs.existsSync(catPath)) {
        fs.mkdirSync(catPath, { recursive: true });
      }
      const kids = Array.isArray(cat.children)
        ? cat.children
        : Array.isArray(cat.subFolders)
          ? (cat.subFolders as string[]).map((s: string) => ({ name: s, children: [] }))
          : [];
      createDirsRecursive(catPath, kids);
    }
  };

  createDirsRecursive(productDir, Array.isArray(folderConfig) && folderConfig.length ? folderConfig : loadProductFolderTemplate());
};

// 添加/更新产品及其变体
app.post('/api/products', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canManageProducts) return res.status(403).json({ error: '无权操作' });
  const { id, sku, official_name, names, brand_id, image_path, variants, folders } = req.body;
  const undo: Array<() => void> = [];
  const renames = Array.isArray(req.body.folderRenames) ? req.body.folderRenames : [];
  if (renames.some((op: any) => op?.type !== 'rename' || !Array.isArray(op.fromSegments) ||
      !op.fromSegments.length || !op.fromSegments.every((s: any) => typeof s === 'string' && validAssetSegment(s)) ||
      typeof op.toName !== 'string' || !validAssetSegment(op.toName))) {
    return res.status(400).json({ error: '目录名称无效' });
  }
  if (Array.isArray(folders)) {
    const error = validateFolderTemplateNames(folders);
    if (error) return res.status(400).json({ error });
  }
  
  const brand = brand_id ? db.prepare('SELECT name FROM brands WHERE id = ?').get(brand_id) as any : null;
  const brandName = brand ? brand.name : undefined;

  const transaction = db.transaction(() => {
    let productId = id;
    const desiredVariants = Array.isArray(variants) ? variants.filter(v => v.sku).map(v => ({ sku: v.sku, color: v.color || '' })) : null;
    const existingVariants = id ? db.prepare("SELECT sku, COALESCE(color, '') AS color FROM product_variants WHERE product_id = ? ORDER BY id").all(id) : [];
    const variantsChanged = desiredVariants !== null && JSON.stringify(desiredVariants) !== JSON.stringify(existingVariants);
    const next = { brand_name: brandName, official_name, sku };
    const previous = id ? db.prepare('SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?').get(id) : null;
    if (id && !previous) throw new Error('产品不存在');
    if (id) {
      db.prepare('UPDATE products SET sku = ?, official_name = ?, names = ?, brand_id = ?, image_path = ? WHERE id = ?')
        .run(sku, official_name, names, brand_id, image_path, id);
      if (variantsChanged) db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(id);
    } else {
      const result = db.prepare('INSERT INTO products (sku, official_name, names, brand_id, image_path) VALUES (?, ?, ?, ?, ?)')
        .run(sku, official_name, names, brand_id, image_path);
      productId = result.lastInsertRowid;
    }

    if (variantsChanged) {
      const insertVariant = db.prepare('INSERT INTO product_variants (product_id, sku, color) VALUES (?, ?, ?)');
      for (const v of variants) {
        if (v.sku) {
          insertVariant.run(productId, v.sku, v.color);
        }
      }
    }
    
    // 自动创建文件夹结构（以产品正式名称命名）
    if (previous) {
      relocateProductFolder(previous, next, undo);
      for (const op of renames) applyTemplateOperation(productRootForRow(next), op, {}, undo);
    }
    const folderList = Array.isArray(folders) && folders.length ? folders : loadProductFolderTemplate();
    if (!previous || !fs.existsSync(productRootForRow(next)) || Array.isArray(folders)) {
      createProductFolders(productRootForRow(next), folderList);
    }
  });

  try {
    transaction();
    res.json({ success: true });
  } catch (err: any) {
    for (const rollback of undo.reverse()) rollback();
    res.status(400).json({ error: err.message || '操作失败' });
  }
});

app.delete('/api/products/:id', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!allowsFolder(perms, 'canDelete', '') || !perms.canManageProducts) return res.status(403).json({ error: '无权操作' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的产品 ID' });
  try {
    db.prepare('DELETE FROM file_tags WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: err.message || '删除失败' });
  }
});

// 给文件打标签 (关联产品和变体)
app.post('/api/files/tag', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canTag) return res.status(403).json({ error: '无权操作' });
  const { file_paths, product_ids, variant_ids } = req.body; 
  
  if (!Array.isArray(file_paths) || !file_paths.every(rel => allowedAsset(perms, 'canTag', rel, true))) {
    return res.status(403).json({ error: '包含无标签权限的项目' });
  }
  const insertTag = db.prepare('INSERT INTO file_tags (file_path, product_id, variant_id) VALUES (?, ?, ?)');
  const deleteTags = db.prepare('DELETE FROM file_tags WHERE file_path = ?');
  
  const transaction = db.transaction((paths: string[], pIds: number[], vIds: number[]) => {
    for (const filePath of paths) {
      deleteTags.run(filePath);
      // 关联产品
      if (pIds) {
        for (const pId of pIds) {
          insertTag.run(filePath, pId, null);
        }
      }
      // 关联变体 (变体本身就属于某个产品，但为了方便查询，我们可以同时记录)
      if (vIds) {
        for (const vId of vIds) {
          const variant = db.prepare('SELECT product_id FROM product_variants WHERE id = ?').get(vId) as any;
          if (variant) {
            insertTag.run(filePath, variant.product_id, vId);
          }
        }
      }
    }
  });
  
  transaction(file_paths, product_ids, variant_ids);
  res.json({ success: true });
});

// 修改文件列表 API 以包含产品标签（云资产不显示「程序图片勿动」）
app.get('/api/files', authenticate, (req: any, res) => {
  let relativePath = ((req.query.path as string) || '').replace(/\\/g, '/');
  const fullPath = path.join(ASSETS_ROOT, relativePath);
  const assetsResolved = path.resolve(ASSETS_ROOT);
  const fullResolved = path.resolve(fullPath);

  if (!fullResolved.startsWith(assetsResolved)) {
    return res.status(403).json({ error: '越权访问' });
  }
  if (relativePath === APP_DATA_FOLDER_NAME || relativePath.startsWith(APP_DATA_FOLDER_NAME + '/')) {
    return res.status(403).json({ error: '该目录为程序数据，不在云资产中显示' });
  }

  try {
    if (!fs.existsSync(fullPath)) return res.json([]);
    const stats = fs.statSync(fullPath);
    if (!stats.isDirectory()) return res.status(400).json({ error: '不是目录' });

    let items = fs.readdirSync(fullPath).map(name => {
      const itemPath = path.join(fullPath, name);
      const itemStats = fs.statSync(itemPath);
      const relPath = path.join(relativePath, name);
      const pathForApi = relPath.replace(/\\/g, '/');
      
      // 获取关联的产品和变体（path 统一用正斜杠）
      const tags = db.prepare(`
        SELECT ft.*, p.sku as product_sku, p.official_name as product_official_name, p.names as product_names, pv.sku as variant_sku, pv.color as variant_color
        FROM file_tags ft 
        JOIN products p ON ft.product_id = p.id 
        LEFT JOIN product_variants pv ON ft.variant_id = pv.id
        WHERE ft.file_path = ?
      `).all(pathForApi) as any[];

      // 如果是文件夹，获取前4个图片的预览图
      let previews: string[] = [];
      if (itemStats.isDirectory()) {
        try {
          const subItems = fs.readdirSync(itemPath);
          previews = subItems
            .filter(si => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(si).toLowerCase()))
            .slice(0, 4)
            .map(si => path.join(relPath, si));
        } catch (e) {}
      }

      return {
        name,
        path: pathForApi,
        isDir: itemStats.isDirectory(),
        size: itemStats.size,
        mtime: itemStats.mtime,
        ext: path.extname(name).toLowerCase(),
        previews: previews.map(p => p.replace(/\\/g, '/')),
        products: tags.map(t => ({
          id: t.product_id,
          sku: t.product_sku,
          official_name: t.product_official_name,
          names: t.product_names,
          variant_id: t.variant_id,
          variant_sku: t.variant_sku,
          variant_color: t.variant_color
        }))
      };
    });
    if (!relativePath || relativePath === '') {
      items = items.filter((x: { name: string }) => x.name !== APP_DATA_FOLDER_NAME);
    }
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: '读取目录失败' });
  }
});

// 递归搜索资产：支持「产品 + 文件夹」如「刮皮刀 主图」，返回匹配的文件和文件夹（文件夹排在图片后面）
app.get('/api/files/search', authenticate, async (req: any, res) => {
  const terms = String(req.query.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return res.json([]);
  const streaming = req.query.stream === '1';
  const results: any[] = [];
  const directories: any[] = [];
  const seen = new Set<string>();
  const maxResults = 240;
  const maxDirectories = 80;
  const concurrency = 8;
  let directoryCount = 0;
  const normalize = (value: string) => (value || '').replace(/\\/g, '/').toLowerCase();
  const folderPreviews = async (rel: string) => {
    const entries = await fs.promises.readdir(path.join(ASSETS_ROOT, rel), { withFileTypes: true }).catch(() => []);
    return entries.filter(e => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name)).slice(0, 4).map(e => rel + '/' + e.name);
  };
  const publish = (items: any[]) => {
    if (!items.length || res.destroyed) return;
    results.push(...items);
    if (streaming) res.write(JSON.stringify(items) + '\n');
  };
  try {
    const tags = db.prepare(`
      SELECT ft.file_path, p.id, p.sku, p.official_name, p.names, pv.sku AS variantSku, pv.color
      FROM file_tags ft JOIN products p ON ft.product_id = p.id
      LEFT JOIN product_variants pv ON ft.variant_id = pv.id
    `).all() as any[];
    const byPath = new Map<string, any[]>();
    for (const tag of tags) {
      const key = normalize(tag.file_path);
      const existing = byPath.get(key) || [];
      existing.push(tag);
      byPath.set(key, existing);
    }
    const products = db.prepare(`
      SELECT p.id, p.sku, p.official_name, p.names, b.name AS brand_name
      FROM products p LEFT JOIN brands b ON p.brand_id = b.id
    `).all() as any[];
    const matches = (term: string, values: string[]) => values.some(value => normalize(value).includes(term));
    const productFields = (p: any) => [p.sku, p.official_name, ...(p.names || '').split(/[,，]/)];
    const productInfo = (p: any) => ({ id: p.id, sku: p.sku, official_name: p.official_name, names: p.names });
    const itemFor = async (rel: string, isDir: boolean, associated: any[]) => {
      const stat = await fs.promises.stat(path.join(ASSETS_ROOT, rel)).catch(() => null);
      if (!stat || stat.isDirectory() !== isDir || res.destroyed) return null;
      return { name: path.posix.basename(rel), path: rel, isDir, size: isDir ? 0 : stat.size,
        mtime: stat.mtime, ext: isDir ? '' : path.extname(rel).toLowerCase(),
        ...(isDir ? { previews: await folderPreviews(rel) } : {}), products: associated.map(productInfo) };
    };
    if (streaming) res.type('application/x-ndjson').set('Cache-Control', 'no-store');
    const boosted = products.filter(p => terms.some(term => matches(term, [...productFields(p), p.brand_name])));
    const queue: string[] = [];
    const scheduled = new Set<string>();
    const enqueue = (rel: string) => {
      const key = normalize(rel);
      if (!scheduled.has(key)) { scheduled.add(key); queue.push(rel); }
    };
    for (let i = 0; i < boosted.length && directoryCount < maxDirectories; i += concurrency) {
      if (res.destroyed) return;
      const rows = await Promise.all(boosted.slice(i, i + concurrency).map(p => {
        const rel = relAssetPath(productRootForRow(p));
        return rel.split('/').every(validAssetSegment) && !rel.startsWith(APP_DATA_FOLDER_NAME + '/') ? itemFor(rel, true, [p]) : null;
      }));
      const batch = [];
      for (const item of rows) {
        if (!item || directoryCount >= maxDirectories || seen.has(normalize(item.path))) continue;
        seen.add(normalize(item.path));
        batch.push(item);
        directoryCount++;
      }
      publish(batch);
    }
    enqueue('');
    for (let head = 0; head < queue.length && results.length + directories.length < maxResults;) {
      if (res.destroyed) return;
      const parents = queue.slice(head, head + concurrency);
      head += parents.length;
      const listings = await Promise.all(parents.map(rel =>
        fs.promises.readdir(path.join(ASSETS_ROOT, rel), { withFileTypes: true }).catch(() => [] as fs.Dirent[])
      ));
      const candidates = [];
      for (const [i, entries] of listings.entries()) {
        for (const entry of entries) {
          if (entry.name === APP_DATA_FOLDER_NAME || (!entry.isDirectory() && !entry.isFile())) continue;
          const rel = parents[i] ? parents[i] + '/' + entry.name : entry.name;
          const key = normalize(rel);
          const isDir = entry.isDirectory();
          if (isDir) enqueue(rel);
          if (seen.has(key) || (isDir && directoryCount >= maxDirectories)) continue;
          const associated = byPath.get(key) || [];
          if (!terms.every(term => key.includes(term) || associated.some(p => matches(term, [...productFields(p), p.variantSku, p.color])))) continue;
          seen.add(key);
          if (isDir) directoryCount++;
          candidates.push({ rel, isDir, associated });
          if (results.length + directories.length + candidates.length >= maxResults) break;
        }
        if (results.length + directories.length + candidates.length >= maxResults) break;
      }
      for (let i = 0; i < candidates.length; i += concurrency) {
        if (res.destroyed) return;
        const rows = await Promise.all(candidates.slice(i, i + concurrency).map(c => itemFor(c.rel, c.isDir, c.associated)));
        const batch = [];
        for (const row of rows) {
          if (!row) continue;
          if (row.isDir) directories.push(row);
          else batch.push(row);
        }
        publish(batch);
      }
    }
    if (res.destroyed) return;
    publish(directories);
    if (streaming) res.end();
    else res.json(results);
  } catch (err) {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: '搜索失败' });
  }
});

// 智能缩略图生成（支持 jpg/png/webp/gif、PSD、PDF、视频）
app.get('/api/thumbnail', async (req: any, res) => {
  let filePath = (req.query.path as string) || '';
  if (!filePath.trim()) return res.status(400).send('Path required');
  // 统一为相对路径：去掉首部斜杠/反斜杠，避免 path.join 在 Windows 上产生错误路径
  filePath = filePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');

  const fullPath = path.join(ASSETS_ROOT, filePath);
  const assetsResolved = path.resolve(ASSETS_ROOT);
  const fullResolved = path.resolve(fullPath);

  const relative = path.relative(assetsResolved, fullResolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return res.status(404).send('Not Found');
  }
  const sourceStat = await fs.promises.stat(fullPath).catch(() => null);
  if (!sourceStat?.isFile()) {
    console.warn(`[Thumbnail] File not found or invalid path: ${filePath} -> ${fullPath}`);
    return res.status(404).send('Not Found');
  }

  const ext = path.extname(fullPath).toLowerCase();

  try {
    // 普通图片：sharp，按最长边缩放（不裁剪），保持原始比例
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      const relNorm = filePath.replace(/\\/g, '/');
      const fresh = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
      if (fresh) {
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'private, max-age=86400');
        return res.send(fresh);
      }

      if (sourceStat.size > NORMAL_IMAGE_THUMB_MAX_BYTES) {
        return res.status(413).send('Image too large for thumbnail');
      }

      const startedAt = Date.now();
      const buffer = await getOrCreateThumb(relNorm, async () => {
        const cached = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
        if (cached) return cached;
        const generated = await sharp(fullPath, { failOn: 'none' })
          .rotate()
          .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        await cacheThumbnail(relNorm, generated);
        const elapsed = Date.now() - startedAt;
        if (elapsed > 2000) {
          console.warn(`Slow thumbnail generated in ${elapsed}ms: ${relNorm} (${sourceStat.size} bytes)`);
        }
        return generated;
      }, imageQueue);
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'private, max-age=86400');
      return res.send(buffer);
    }

    // PSD：缓存到勿动/thumbs，先读缓存（兼容旧 psd_thumbs），无缓存或源文件更新则重新生成
    if (ext === '.psd') {
      try {
        const relNorm = filePath.replace(/\\/g, '/');
        const fresh = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
        if (fresh) {
          res.set('Content-Type', 'image/webp');
          return res.send(fresh);
        }
        const buffer = await getOrCreateThumb(relNorm, async () => {
          const cached = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
          if (cached) return cached;
        // 兼容旧目录
        const oldThumbPath = path.join(PSD_THUMB_DIR, encodeURIComponent(relNorm) + '.webp');
        if (fs.existsSync(oldThumbPath)) {
          try {
            const psdStat = fs.statSync(fullPath);
            const thumbStat = fs.statSync(oldThumbPath);
            if (thumbStat.mtimeMs >= psdStat.mtimeMs) {
              return fs.readFileSync(oldThumbPath);
            }
          } catch (_) {}
        }
        await import('ag-psd/initialize-canvas.js');
        const { readPsd } = await import('ag-psd');
        const buf = fs.readFileSync(fullPath);
        const psd = readPsd(buf, { skipLayerImageData: true });
        const canvas = psd.canvas ?? (psd as any).imageResources?.thumbnail;
        if (!canvas) throw new Error('No canvas');
        const pngBuf = typeof canvas.toBuffer === 'function'
          ? canvas.toBuffer('image/png')
          : Buffer.from((canvas.toDataURL?.('image/png') || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const buffer = await sharp(pngBuf)
          .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        await cacheThumbnail(relNorm, buffer);
          return buffer;
        });
        res.set('Content-Type', 'image/webp');
        return res.send(buffer);
      } catch (e) {
        console.warn('PSD thumbnail failed:', e);
        return res.status(400).send('PSD thumbnail not available');
      }
    }

    // PDF：缓存到勿动/thumbs，有缓存且源文件未变更则直接返回，否则生成并写入
    if (ext === '.pdf') {
      try {
        const relNorm = filePath.replace(/\\/g, '/');
        const fresh = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
        if (fresh) {
          res.set('Content-Type', 'image/webp');
          return res.send(fresh);
        }
        console.log(`[PDF Thumbnail] Generating for: ${relNorm}`);
        const buffer = await getOrCreateThumb(relNorm, async () => {
          const cached = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
          if (cached) return cached;
          const buffer = await renderPdfLikeFirstPageToWebp(fullPath);
          await cacheThumbnail(relNorm, buffer);
          console.log(`[PDF Thumbnail] Success: ${relNorm}`);
          return buffer;
        });
        res.set('Content-Type', 'image/webp');
        return res.send(buffer);
      } catch (e) {
        console.error('[PDF Thumbnail] Error:', e);
        return res.status(400).send('PDF thumbnail not available');
      }
    }

    // AI：优先按 PDF 渲染生成缩略图（很多 AI 实际是 PDF 兼容），失败则回退占位图；结果缓存到勿动/thumbs
    if (ext === '.ai') {
      const relNorm = filePath.replace(/\\/g, '/');
      const fresh = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
      if (fresh) {
        if (!(await isLikelyAiPlaceholder(fresh))) {
          res.set('Content-Type', 'image/webp');
          return res.send(fresh);
        }
        try { fs.unlinkSync(getThumbPath(relNorm)); } catch (_) {}
      }
      try {
        const buffer = await getOrCreateThumb(relNorm, async () => {
          const cached = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
          if (cached && !(await isLikelyAiPlaceholder(cached))) return cached;
          const buffer = await renderPdfLikeFirstPageToWebp(fullPath);
          await cacheThumbnail(relNorm, buffer);
          return buffer;
        });
        res.set('Content-Type', 'image/webp');
        return res.send(buffer);
      } catch (e) {
        // 回退：占位图（依然缓存，避免每次都重试解析）
        console.warn('AI thumbnail failed:', e);
        return res.status(400).send('AI thumbnail not available');
      }
    }

    // 视频：用 ffmpeg 抽取首帧（约 1 秒处，避免黑屏首帧）生成缩略图，缓存到勿动/thumbs
    if (VIDEO_THUMB_EXTS.includes(ext)) {
      const relNorm = filePath.replace(/\\/g, '/');
      const fresh = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
      if (fresh) {
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'private, max-age=86400');
        return res.send(fresh);
      }
      try {
        const buffer = await getOrCreateThumb(relNorm, async () => {
          const cached = await readCachedThumbIfFresh(relNorm, sourceStat.mtimeMs);
          if (cached) return cached;
          // 先尝试 1 秒处抽帧，失败再退回到第 0 帧（短视频可能不足 1 秒）
          let frame = await extractVideoFrame(fullPath, 1);
          if (!frame) frame = await extractVideoFrame(fullPath, 0);
          if (!frame) throw new Error('ffmpeg frame extraction failed');
          const generated = await sharp(frame)
            .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          await cacheThumbnail(relNorm, generated);
          return generated;
        });
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'private, max-age=86400');
        return res.send(buffer);
      } catch (e) {
        console.warn('Video thumbnail failed:', e);
        return res.status(400).send('Video thumbnail not available');
      }
    }

    return res.status(400).send('Not supported');
  } catch (err) {
    console.error('Thumbnail error:', err);
    res.status(500).send('Thumbnail error');
  }
});

// 大文件流式下载（inline=1 时用于预览，不强制下载）；路径规范与 thumbnail 一致
app.post('/api/files/download-access', authenticate, (req: any, res) => {
  const paths = req.body?.paths;
  const perms = getReqPermissions(req);
  if (!Array.isArray(paths) || !paths.length || !paths.every(p => p && allowedAsset(perms, 'canDownload', p, false, true))) {
    return res.status(403).json({ error: '没有所选项目的下载权限' });
  }
  res.sendStatus(204);
});

app.get('/api/download', authenticate, (req: any, res: any) => {
  let filePath = (req.query.path as string) || '';
  filePath = filePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!allowedAsset(getReqPermissions(req), 'canDownload', filePath, false, true)) return res.status(403).json({ error: '没有此目录的下载权限' });
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  const fullPath = path.join(ASSETS_ROOT, filePath);
  const assetsResolved = path.resolve(ASSETS_ROOT);
  const fullResolved = path.resolve(fullPath);

  if (!fs.existsSync(fullPath) || !fullResolved.startsWith(assetsResolved)) {
    return res.status(404).send('Not Found');
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) return res.status(404).send('Not Found');
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fullPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mime.lookup(fullPath) || 'application/octet-stream',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head: Record<string, string> = {
      'Content-Length': String(fileSize),
      'Content-Type': mime.lookup(fullPath) || 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${encodeURIComponent(path.basename(fullPath))}"`
    };
    res.writeHead(200, head);
    fs.createReadStream(fullPath).pipe(res);
  }
});

// 多文件/文件夹打包下载为 zip（用于多选下载，只触发一次下载）
app.get('/api/download-zip', authenticate, (req: any, res: any) => {
  const perms = getReqPermissions(req);
  if (!perms.canDownload) return res.status(403).json({ error: '无权下载' });

  const raw = req.query.paths;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const paths = (list as string[])
    .map(p => (p || '').replace(/^[/\\]+/, '').replace(/\\/g, '/').trim())
    .filter(p => p && !p.includes('..'));

  if (!paths.length) {
    return res.status(400).json({ error: '缺少要打包的路径' });
  }

  const assetsResolved = path.resolve(ASSETS_ROOT);
  if (paths.length !== list.length || !paths.every(rel => allowedAsset(perms, 'canDownload', rel))) {
    return res.status(403).json({ error: '包含无下载权限的项目' });
  }
  const stamp = new Date();
  const ts = [
    stamp.getFullYear(),
    String(stamp.getMonth() + 1).padStart(2, '0'),
    String(stamp.getDate()).padStart(2, '0'),
    String(stamp.getHours()).padStart(2, '0'),
    String(stamp.getMinutes()).padStart(2, '0')
  ].join('');
  const baseName =
    paths.length === 1
      ? path.basename(paths[0]) || 'assets'
      : 'assets';
  const zipName = `${baseName}-${ts}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(zipName)}"`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('download-zip error:', err);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  for (const rel of paths) {
    const full = path.resolve(ASSETS_ROOT, rel);
    if (!full.startsWith(assetsResolved) || !fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // 单文件夹下载时 zip 内只保留文件夹名（如「主图」），解压后不会出现整条路径
      const entryName = paths.length === 1 ? path.basename(rel) || rel : rel;
      archive.directory(full, entryName);
    } else {
      archive.file(full, { name: rel });
    }
  }

  archive.finalize().catch((err: any) => {
    console.error('archive finalize error:', err);
    try { res.end(); } catch (_) {}
  });
});

// 读取卖点身份证 (selling_points.xlsx)
app.get('/api/selling-points', authenticate, (req: any, res) => {
  const excelPath = path.join(ASSETS_ROOT, 'selling_points.xlsx');
  if (!fs.existsSync(excelPath)) {
    return res.json({});
  }

  try {
    const workbook = xlsx.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const data: any[] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    const pointsMap: Record<string, any> = {};
    data.forEach(row => {
      const key = row['产品名称'] || row['文件夹名'] || Object.values(row)[0];
      if (key) pointsMap[String(key)] = row;
    });
    res.json(pointsMap);
  } catch (err) {
    res.status(500).json({ error: '读取卖点表失败' });
  }
});

// 文件操作（权限通过 users.json 控制）
const upload = multer({ dest: 'uploads/', limits: { fileSize: UPLOAD_FILE_LIMIT_BYTES } }); // 单文件 3GB
app.post('/api/upload', authenticate, (req: any, res: any, next: any) => {
  upload.array('files')(req, res, (err: any) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件过大，单文件限制 3GB' });
    }
    if (err) {
      const status = err?.status || err?.statusCode;
      if (status === 413 || err?.type === 'entity.too.large') {
        return res.status(413).json({ error: '上传内容过大，请压缩图片或分批上传' });
      }
      console.error('Upload parser error:', err);
      return res.status(500).json({ error: err.message || '上传失败' });
    }
    next();
  });
}, (req: any, res) => {
  const perms = getReqPermissions(req);
  const stagedFiles = (req.files || []) as Express.Multer.File[];
  res.once('finish', () => {
    for (const file of stagedFiles) fs.promises.unlink(file.path).catch(() => {});
  });
  if (!perms.canUpload) return res.status(403).json({ error: '无权操作' });
  try {
    let targetDir = (req.body.path || '').replace(/\\/g, '/');
    const conflictStrategyRaw = String(req.body.conflictStrategy || '').trim().toLowerCase();
    const conflictStrategy: 'overwrite' | 'rename' = conflictStrategyRaw === 'overwrite' ? 'overwrite' : 'rename';
    if (targetDir.includes('..')) return res.status(400).json({ error: '路径非法' });
    // 仅产品管理里选择的主图上传到「程序图片勿动/product_images」，云资产中隐藏；其余上传仍用当前路径，正常显示
    if (targetDir === 'product_images') targetDir = `${APP_DATA_FOLDER_NAME}/product_images`;
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) return res.status(400).json({ error: '未收到文件' });
    
    const workflow = req.body.newDevProject;
    const workflowId = workflow === 'draft' ? null : Number(workflow);
    if (workflow && workflow !== 'draft') {
      const project = db.prepare('SELECT * FROM newdev_projects WHERE id = ?').get(workflowId) as any;
      if (!project || project.completed_at || !canSupplementNewDevStep(req, project.current_step_key, project)) {
        return res.status(403).json({ error: '当前无法上传流程附件' });
      }
      const root = parseProjectData(project).productFolderPath || `新品开发/${safeTemplateName(project.title)}`;
      if (!targetDir.startsWith(root + '/')) return res.status(409).json({ error: '产品目录已变更，请刷新后重试' });
      targetDir = generatedFolderPath(targetDir.slice(root.length + 1).split('/'), root);
    }
    if (workflow === 'draft') {
      const existing = req.body.draftSku && db.prepare('SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.sku = ?').get(req.body.draftSku);
      targetDir = existing
        ? generatedFolderPath(['检测报告'], relAssetPath(productRootForRow(existing)))
        : generatedFolderPath(targetDir.split('/'));
    }
    if (!workflow && targetDir && !fs.existsSync(path.join(ASSETS_ROOT, targetDir))) {
      const parts = targetDir.split('/');
      if (parts.every(validAssetSegment)) {
        const relocated = generatedFolderPath(parts);
        if (relocated !== targetDir && fs.existsSync(path.join(ASSETS_ROOT, relocated))) targetDir = relocated;
      }
    }
    if (workflow && conflictStrategy === 'overwrite') return res.status(400).json({ error: '流程附件必须单独保存' });
    const assetsResolved = path.resolve(ASSETS_ROOT);
    if (!allowedAsset(perms, 'canUpload', targetDir, false, true)) return res.status(403).json({ error: '没有此目录的上传权限' });
    const uploadedFiles: { name: string; path: string }[] = [];
    const conflictedFiles: { name: string; path: string }[] = [];

    const getUniqueFilePath = (target: string): string => {
      if (!fs.existsSync(target)) return target;
      const dir = path.dirname(target);
      const ext = path.extname(target);
      const base = path.basename(target, ext);
      let i = 1;
      while (true) {
        const candidate = path.join(dir, `${base}(${i})${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
        i += 1;
      }
    };

    const destinations = [];
    for (const file of files) {
      // 统一处理中文文件名编码：部分环境下 originalname 会按 latin1 解码，这里转回 UTF-8
      let originalName = (file.originalname || '').replace(/\\/g, '/');
      try {
        const buf = Buffer.from(originalName, 'latin1');
        const utf8Name = buf.toString('utf8');
        if (utf8Name && utf8Name !== originalName) originalName = utf8Name;
      } catch (_) {}
      // 支持带子目录的相对路径（上传文件夹时保留目录结构）
      const relParts = originalName.split('/').filter(Boolean);
      if (relParts.some((p: string) => p === '..')) return res.status(400).json({ error: '路径非法' });
      const safeRel = relParts.join(path.sep);
      const desiredPath = path.join(ASSETS_ROOT, targetDir, safeRel);
      if (!relParts.length || !relParts.every(validAssetSegment) ||
          !safeAssetPath(ASSETS_ROOT, path.relative(ASSETS_ROOT, desiredPath), true) ||
          !path.resolve(desiredPath).startsWith(assetsResolved)) {
        return res.status(400).json({ error: '路径非法' });
      }

      destinations.push({ file, desiredPath, safeRel });
    }
    for (const { file, desiredPath, safeRel } of destinations) {
      if (conflictStrategyRaw === 'ask' && fs.existsSync(desiredPath)) {
        conflictedFiles.push({
          name: path.basename(desiredPath),
          path: path.join(targetDir, safeRel).replace(/\\/g, '/')
        });
        continue;
      }

      const finalPath = conflictStrategy === 'rename' ? getUniqueFilePath(desiredPath) : desiredPath;
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      try {
        if (conflictStrategy === 'overwrite' && fs.existsSync(finalPath)) {
          fs.unlinkSync(finalPath);
        }
        fs.renameSync(file.path, finalPath);
      } catch (e: any) {
        if (e?.code === 'EXDEV') {
          fs.copyFileSync(file.path, finalPath);
          fs.unlinkSync(file.path);
        } else {
          throw e;
        }
      }
      if (workflow) {
        const rel = path.relative(ASSETS_ROOT, finalPath).split(path.sep).join('/');
        const stamp = uploadStamp(rel);
        if (!stamp) throw new Error('流程附件路径无效');
        db.prepare('INSERT OR REPLACE INTO newdev_uploads(file_path, project_id, uploader, file_stamp) VALUES (?, ?, ?, ?)')
          .run(rel, workflowId, req.user.username, stamp);
      }
      uploadedFiles.push({
        name: path.basename(finalPath),
        path: path.join(targetDir, path.relative(path.join(ASSETS_ROOT, targetDir), finalPath)).replace(/\\/g, '/')
      });
    }

    if (conflictedFiles.length > 0) {
      return res.status(409).json({ error: '检测到同名文件，请选择处理方式', code: 'FILE_CONFLICT', conflicts: conflictedFiles });
    }
    res.json({ success: true, files: uploadedFiles });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || '上传失败' });
  }
});

// 安全删除：带重试，缓解 Windows 下 EPERM（文件被占用）
function safeUnlinkSync(targetPath: string, retries = 5): void {
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      fs.unlinkSync(targetPath);
      return;
    } catch (e: any) {
      lastErr = e;
      if (e?.code === 'EPERM' && i < retries - 1) {
        const delay = 150 * (i + 1);
        const deadline = Date.now() + delay;
        while (Date.now() < deadline) { /* spin wait */ }
      } else {
        throw e;
      }
    }
  }
  if (lastErr) throw lastErr;
}

app.use((err: any, req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  const status = err?.status || err?.statusCode;
  if (status === 413 || err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '上传内容过大，请压缩图片或分批上传' });
  }
  console.error('Unhandled request error:', err);
  res.status(status && status >= 400 && status < 600 ? status : 500).json({ error: err?.message || '服务端错误' });
});

function sleepMs(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* spin */ }
}

function safeUnlinkOrRmdir(targetPath: string, isDir: boolean, retries = 8): void {
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      if (isDir) fs.rmdirSync(targetPath);
      else fs.unlinkSync(targetPath);
      return;
    } catch (e: any) {
      lastErr = e;
      if (e?.code === 'EPERM' || e?.code === 'EBUSY') {
        try { fs.chmodSync(targetPath, 0o666); } catch (_) {}
        if (i < retries - 1) sleepMs(250 * (i + 1));
      } else {
        throw e;
      }
    }
  }
  if (lastErr) throw lastErr;
}

function safeRmSyncRecursive(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function deleteThumbsUnderPrefix(relPath: string): void {
  const normalized = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relPrefix = normalized + '/';
  const nested = longThumbPath(normalized);
  if (fs.existsSync(nested)) safeRmSyncRecursive(nested);
  deleteThumbForPath(normalized);
  for (const dir of [THUMB_CACHE_DIR, PSD_THUMB_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    files.forEach((name) => {
      try {
        const decoded = decodeURIComponent(name.replace(/\.webp$/i, ''));
        if (decoded === normalized || decoded.startsWith(relPrefix)) {
          safeUnlinkOrRmdir(path.join(dir, name), false);
        }
      } catch (_) {}
    });
  }
}

app.get('/api/files/folder-info', authenticate, (req: any, res) => {
  const folderPath = (req.query.path as string)?.replace(/\\/g, '/').replace(/^[/\\]+/, '') || '';
  if (!folderPath || folderPath.includes('..')) return res.status(400).json({ error: '路径非法' });

  const assetsResolved = path.resolve(ASSETS_ROOT);
  const fullPath = path.resolve(ASSETS_ROOT, folderPath);
  if (!fullPath.startsWith(assetsResolved) || fullPath === assetsResolved) return res.status(400).json({ error: '路径非法' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件夹不存在' });
  if (!fs.statSync(fullPath).isDirectory()) return res.status(400).json({ error: '不是文件夹' });

  try {
    const entries = fs.readdirSync(fullPath);
    res.json({
      path: folderPath,
      isEmpty: entries.length === 0,
      itemCount: entries.length,
      childPaths: entries.map(name => path.join(folderPath, name).replace(/\\/g, '/')),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '读取文件夹失败' });
  }
});

app.post('/api/files/rename', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canRename) return res.status(403).json({ error: '无权操作' });

  const filePath = String(req.body?.path || '').replace(/\\/g, '/').replace(/^[/\\]+/, '').trim();
  const newName = String(req.body?.newName || '').trim();
  if (!filePath || filePath.includes('..')) return res.status(400).json({ error: '路径非法' });
  if (!validAssetSegment(newName)) return res.status(400).json({ error: '名称无效' });
  if (/[<>:"/\\|?*\x00-\x1f]/.test(newName) || newName === '.' || newName === '..') {
    return res.status(400).json({ error: '名称包含非法字符' });
  }

  if (!allowedAsset(perms, 'canRename', filePath, true)) return res.status(403).json({ error: '没有此目录的重命名权限' });
  const assetsResolved = path.resolve(ASSETS_ROOT);
  const srcFull = path.resolve(ASSETS_ROOT, filePath);
  if (!srcFull.startsWith(assetsResolved) || srcFull === assetsResolved) return res.status(400).json({ error: '路径非法' });
  if (!fs.existsSync(srcFull)) return res.status(404).json({ error: '文件或文件夹不存在' });

  const parentRel = path.dirname(filePath).replace(/\\/g, '/');
  const normalizedParent = parentRel === '.' ? '' : parentRel;
  const destRel = path.join(normalizedParent, newName).replace(/\\/g, '/');
  const destFull = path.resolve(ASSETS_ROOT, destRel);
  if (!destFull.startsWith(assetsResolved)) return res.status(400).json({ error: '新路径非法' });
  if (destFull === srcFull) return res.json({ success: true, path: destRel, name: newName });
  if (fs.existsSync(destFull) && !(process.platform === 'win32' && srcFull.toLowerCase() === destFull.toLowerCase())) return res.status(409).json({ error: '同级目录已存在同名项目' });

  try {
    renameAsset(srcFull, destFull, true);
    res.json({ success: true, path: destRel, name: newName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '重命名失败' });
  }
});

app.delete('/api/files', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canDelete) return res.status(403).json({ error: '无权操作' });
  
  let filePath = (req.query.path as string)?.replace(/\\/g, '/').replace(/^[/\\]+/, '') || '';
  if (!filePath || filePath.includes('..')) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!allowedAsset(perms, 'canDelete', filePath, true)) return res.status(403).json({ error: '没有此目录的删除权限' });
  const fullPath = path.resolve(ASSETS_ROOT, filePath);
  const assetsResolved = path.resolve(ASSETS_ROOT);
  if (!fullPath.startsWith(assetsResolved) || fullPath === assetsResolved) {
    return res.status(400).json({ error: '路径非法' });
  }
  
  try {
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (fs.statSync(fullPath).isDirectory()) {
      if (req.query.emptyOnly === '1' && fs.readdirSync(fullPath).length > 0) {
        return res.status(409).json({ error: '文件夹仍有内容，不能删除空文件夹' });
      }
      safeRmSyncRecursive(fullPath);
      deleteTagPathPrefix(filePath);
    } else {
      db.prepare("DELETE FROM file_tags WHERE file_path = ?").run(filePath);
      safeUnlinkOrRmdir(fullPath, false);
      const ext = path.extname(fullPath).toLowerCase();
      deleteThumbForPath(filePath);
      if (ext === '.psd') {
        try {
          const oldThumb = path.join(PSD_THUMB_DIR, encodeURIComponent(filePath) + '.webp');
          if (fs.existsSync(oldThumb)) safeUnlinkOrRmdir(oldThumb, false);
        } catch (_) {}
      }
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete error:', err);
    const msg = err?.code === 'EPERM' || err?.message?.includes('被占用')
      ? (err.message || '删除失败：文件可能被占用，请稍后重试')
      : (err.message || '删除失败');
    res.status(500).json({ error: msg });
  }
});

// 批量移动文件/文件夹到指定目录
app.post('/api/files/move', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (!perms.canMove) return res.status(403).json({ error: '无权操作' });

  const { paths, destination } = req.body as { paths: string[]; destination: string };
  if (!Array.isArray(paths) || !paths.length) {
    return res.status(400).json({ error: '缺少文件路径' });
  }
  const dest = (destination ?? '').replace(/\\/g, '/').replace(/^[/\\]+/, '');
  if (dest.includes('..')) return res.status(400).json({ error: '目标路径非法' });

  if (!allowedAsset(perms, 'canMove', dest) || !paths.every(rel => allowedAsset(perms, 'canMove', rel, true))) {
    return res.status(403).json({ error: '来源和目标必须都在移动权限范围内' });
  }
  const assetsResolved = path.resolve(ASSETS_ROOT);
  const destFull = path.resolve(ASSETS_ROOT, dest);
  if (!destFull.startsWith(assetsResolved)) {
    return res.status(400).json({ error: '目标路径非法' });
  }
  if (!fs.existsSync(destFull) || !fs.statSync(destFull).isDirectory()) {
    return res.status(400).json({ error: '目标目录不存在' });
  }

  const results: { path: string; success: boolean; newPath?: string; error?: string }[] = [];

  for (const rawPath of paths) {
    const filePath = (rawPath as string).replace(/\\/g, '/').replace(/^[/\\]+/, '');
    if (!filePath || filePath.includes('..')) {
      results.push({ path: rawPath, success: false, error: '路径非法' });
      continue;
    }
    const srcFull = path.resolve(ASSETS_ROOT, filePath);
    if (!srcFull.startsWith(assetsResolved) || srcFull === assetsResolved) {
      results.push({ path: rawPath, success: false, error: '路径非法' });
      continue;
    }
    if (!fs.existsSync(srcFull)) {
      results.push({ path: rawPath, success: false, error: '文件不存在' });
      continue;
    }
    // 不允许移动到自身或其子目录
    if (destFull === srcFull || destFull.startsWith(srcFull + path.sep)) {
      results.push({ path: rawPath, success: false, error: '不能移动到自身或其子目录' });
      continue;
    }
    const baseName = path.basename(srcFull);
    let destFileFull = path.join(destFull, baseName);
    // 重名则自动加后缀
    if (fs.existsSync(destFileFull) && destFileFull !== srcFull) {
      const ext = path.extname(baseName);
      const base = path.basename(baseName, ext);
      let i = 1;
      while (fs.existsSync(destFileFull)) {
        destFileFull = path.join(destFull, `${base}(${i})${ext}`);
        i++;
      }
    }
    const newRelPath = path.join(dest, path.basename(destFileFull)).replace(/\\/g, '/');
    try {
      if (srcFull === destFileFull) {
        results.push({ path: rawPath, success: true, newPath: newRelPath });
        continue;
      }
      fs.renameSync(srcFull, destFileFull);
      // 更新数据库中的文件标签路径
      const isSrcDir = fs.statSync(destFileFull).isDirectory();
      if (isSrcDir) {
        const rows = db.prepare('SELECT file_path FROM file_tags WHERE file_path LIKE ?')
          .all(`${filePath.replace(/%/g, '\\%')}/%`) as { file_path: string }[];
        const updateTag = db.prepare('UPDATE file_tags SET file_path = ? WHERE file_path = ?');
        for (const row of rows) {
          const newTagPath = newRelPath + row.file_path.slice(filePath.length);
          updateTag.run(newTagPath, row.file_path);
        }
      } else {
        db.prepare('UPDATE file_tags SET file_path = ? WHERE file_path = ?').run(newRelPath, filePath);
        // 移动后旧缩略图缓存作废，直接删除，下次访问时重新生成
        const ext = path.extname(srcFull).toLowerCase();
        if (['.psd', '.pdf', '.ai'].includes(ext)) {
          deleteThumbForPath(filePath);
        }
      }
      results.push({ path: rawPath, success: true, newPath: newRelPath });
    } catch (e: any) {
      results.push({ path: rawPath, success: false, error: e.message || '移动失败' });
    }
  }

  const failed = results.filter(r => !r.success);
  if (failed.length === results.length) {
    return res.status(500).json({ error: '全部移动失败', results });
  }
  res.json({ success: true, results });
});

function validAssetSegment(value: string) {
  return !!value && !/[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

// Resolve the existing parent too, so directory junctions cannot reach private or external files.
function visibleAssetPath(fullPath: string) {
  const root = fs.realpathSync(ASSETS_ROOT);
  const relative = path.relative(root, path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath)));
  return relative.split(path.sep).every(validAssetSegment) && !path.isAbsolute(relative) &&
    relative.split(path.sep)[0].toLowerCase() !== APP_DATA_FOLDER_NAME.toLowerCase();
}

// 创建文件夹（是否允许由 users.json 控制）
app.post('/api/mkdir', authenticate, (req: any, res) => {
  const perms = getReqPermissions(req);
  if (perms.canCreateFolder !== true) return res.status(403).json({ error: '无权新建文件夹' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const parent = req.body.path ?? '';
  if (!validAssetSegment(name) || typeof parent !== 'string' ||
      (parent && !parent.split(/[\\/]/).every(validAssetSegment))) {
    return res.status(400).json({ error: '文件夹名称或路径无效' });
  }
  if (!allowedAsset(perms, 'canCreateFolder', parent)) return res.status(403).json({ error: '没有此目录的新建文件夹权限' });
  try {
    const fullPath = path.join(ASSETS_ROOT, parent, name);
    if (!visibleAssetPath(fullPath)) return res.status(403).json({ error: '目录不可用' });
    fs.mkdirSync(fullPath);
    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 'EEXIST') return res.status(409).json({ error: '同名文件或文件夹已存在' });
    res.status(500).json({ error: '创建文件夹失败' });
  }
});

// --- Vite 整合 ---
export async function startServer(): Promise<number> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const staticDir = process.env.STATIC_DIR || path.join(process.cwd(), 'dist');
    app.use(express.static(staticDir));
  }

  const basePort = Number(process.env.PORT) || PORT;
  const portFile = process.env.PORT_FILE;

  function tryListen(port: number, allowFallback: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, '0.0.0.0', () => {
        const actualPort = (server.address() as { port: number }).port;
        const lan = getLanAddress(actualPort);
        console.log(`尚品易站云资产 运行在 http://localhost:${actualPort}`);
        if (lan) console.log(`局域网访问: ${lan}`);
        console.log(`映射资产目录: ${ASSETS_ROOT}`);
        if (portFile) {
          try {
            fs.writeFileSync(portFile, String(actualPort), 'utf8');
          } catch (e) {
            console.warn('写入端口文件失败:', e);
          }
        }
        resolve(actualPort);
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          if (allowFallback && port < basePort + 50) {
            tryListen(port + 1, true).then(resolve).catch(reject);
          } else {
            reject(new Error(`端口 ${basePort}-${basePort + 50} 均已被占用，请关闭占用端口的程序后重试`));
          }
        } else {
          reject(err);
        }
      });
    });
  }

  const listenPorts = [basePort];
  const startedPorts = await Promise.allSettled(listenPorts.map((port, index) => tryListen(port, index === 0)));
  const okPorts = startedPorts.filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled');
  if (!okPorts.length) {
    throw new Error(`Unable to listen on ports ${listenPorts.join(', ')}`);
  }
  return okPorts[0].value;
}

// 仅在被直接运行（如 tsx server.ts）时自动启动，被 Electron 引用时不自动启动
if (process.env.PRODUCT_FOLDER_SYNC_JOB) {
  runProductFolderSyncJob(process.env.PRODUCT_FOLDER_SYNC_JOB);
  process.exit(0);
}

const isRunDirectly = process.argv.some(
  (arg) => typeof arg === 'string' && (arg.includes('server') || arg.includes('run-server'))
);
if (isRunDirectly) {
  startServer();
}
