const { contextBridge, ipcRenderer, webUtils } = require('electron');

let _onOsFilesDropped = () => {};
ipcRenderer.on('os-files-dropped', (_, paths) => { _onOsFilesDropped(paths); });

// 从拖放的 File 对象获取本机路径（Electron 新版本中 .path 可能被移除，用 webUtils 兜底）
function getPathForFile(file) {
  if (!file || typeof file !== 'object') return '';
  try {
    if (file.path && typeof file.path === 'string') return file.path;
    if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file) || '';
  } catch (_) {}
  return '';
}

contextBridge.exposeInMainWorld('electron', {
  openFile: (relativePath, downloadUrl) => ipcRenderer.invoke('open-file', relativePath, downloadUrl),
  showItemInFolder: (relativePath, downloadUrl) => ipcRenderer.invoke('show-item-in-folder', relativePath, downloadUrl),
  // startDrag(paths, downloadUrls, isDirs?)
  startDrag: (paths, downloadUrls, isDirs) =>
    ipcRenderer.send(
      'ondragstart',
      Array.isArray(paths) ? paths : [paths],
      downloadUrls,
      Array.isArray(isDirs) ? isDirs : undefined
    ),
  notifyDragEnd: () => ipcRenderer.send('drag-end'),
  downloadUrl: (url) => ipcRenderer.send('download-url', url),
  onDownloadProgress: (fn) => {
    if (typeof fn !== 'function') return () => {};
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
  setOnOsFilesDropped: (fn) => { _onOsFilesDropped = typeof fn === 'function' ? fn : () => {}; },
  uploadLocalPaths: (opts) => ipcRenderer.invoke('upload-local-paths', opts),
  getFilesFromDir: (dirPath) => ipcRenderer.invoke('get-files-from-dir', dirPath),
  getPathForFile,
  setNotificationState: (payload) => ipcRenderer.send('notification-state', payload),
});
contextBridge.exposeInMainWorld('__debugLogToFile', (payload) => ipcRenderer.invoke('debug-log', payload));
