export const folderActions = ['canUpload', 'canDownload', 'canDelete', 'canRename', 'canMove', 'canCreateFolder', 'canTag'];

export function enabledAction(permissions, action) {
  const flag = permissions?.[action];
  if (flag === undefined && (action === 'canRename' || action === 'canMove')) return permissions?.canUpload === true;
  return flag === true;
}

export function scopeOf(permissions, action) {
  const scopes = permissions?.folderScopes;
  if (scopes === undefined) return 'all'; // Accounts saved before folder permissions.
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return [];
  return Object.hasOwn(scopes, action) ? scopes[action] : 'all';
}

export function allowsFolder(permissions, action, relative, contentsOnly = false) {
  if (!enabledAction(permissions, action) || typeof relative !== 'string') return false;
  const scope = scopeOf(permissions, action);
  if (scope === 'all') return true;
  const path = relative.replace(/\\/g, '/');
  return Array.isArray(scope) && scope.some(root => typeof root === 'string' && root &&
    ((!contentsOnly && path === root) || path.startsWith(root + '/')));
}
