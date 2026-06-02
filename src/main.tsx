import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';
import App from './App.tsx';
import './index.css';

const root = document.getElementById('root')!;
try {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  root.innerHTML = `<div style="padding:24px;background:#0f172a;color:#e2e8f0;font-family:system-ui;min-height:100vh">
    <h1 style="font-size:24px;margin-bottom:16px">启动失败</h1>
    <pre style="background:#1e293b;padding:16px;border-radius:8px;overflow:auto;font-size:12px">${String(err)}</pre>
    <p style="margin-top:16px;color:#94a3b8">请关闭后重新启动，或联系技术支持</p>
  </div>`;
  console.error(err);
}
