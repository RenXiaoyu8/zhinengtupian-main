const fs = require('fs');
const path = require('path');

function validSegment(name) {
  return typeof name === 'string' && !!name && !/[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

// Validate each existing ancestor, including the final entry. Uploads may create the missing suffix.
function safeAssetPath(root, raw, allowProductImages = false) {
  if (typeof raw !== 'string') return false;
  const parts = raw === '' ? [] : raw.split(/[\\/]/);
  if (!parts.every(validSegment)) return false;
  if (parts[0]?.toLowerCase() === '程序图片勿动' &&
      !(allowProductImages && parts[1] === 'product_images')) return false;
  try {
    let current = fs.realpathSync.native(root);
    for (const part of parts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) break;
      if (stat.isSymbolicLink()) return false;
      if (process.platform === 'win32' && fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) return false;
    }
    return true;
  } catch { return false; }
}

async function childFolders(root, relative) {
  if (!safeAssetPath(root, relative)) throw new Error('目录不可用');
  const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && validSegment(e.name) &&
    (relative || e.name !== '程序图片勿动')).map(e => e.name).sort((a,b) => a.localeCompare(b, 'zh-CN'));
}

function validScopes(scopes) {
  if (scopes === undefined) return true;
  return scopes !== null && typeof scopes === 'object' && !Array.isArray(scopes) &&
    Object.entries(scopes).every(([key, value]) =>
      ['canDelete', 'canRename', 'canMove', 'canCreateFolder', 'canUpload', 'canDownload', 'canTag'].includes(key) &&
      (value === 'all' || Array.isArray(value) && value.every(p => typeof p === 'string' &&
        p.split('/').every(validSegment) && p.split('/')[0] !== '程序图片勿动')));
}

module.exports = { safeAssetPath, childFolders, validScopes };
