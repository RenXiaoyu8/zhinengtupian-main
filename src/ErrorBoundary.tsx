import React from 'react';

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  declare props: { children: React.ReactNode; fallback?: React.ReactNode };

  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#0f172a',
          color: '#e2e8f0',
          fontFamily: 'system-ui',
        }}>
          <h1 style={{ fontSize: 24, marginBottom: 16 }}>启动出错</h1>
          <pre style={{
            background: '#1e293b',
            padding: 16,
            borderRadius: 8,
            overflow: 'auto',
            maxWidth: '100%',
            fontSize: 12,
          }}>
            {this.state.error.message}
          </pre>
          <p style={{ marginTop: 16, color: '#94a3b8', fontSize: 14 }}>
            请关闭后重新启动，或联系技术支持
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
