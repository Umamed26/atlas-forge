/** Top-level error boundary: never show a white screen. */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Atlas Forge UI crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card" role="alert">
          <h1>界面遇到未处理的错误</h1>
          <p>世界数据仍保存在浏览器本地自动存档中，刷新页面即可恢复。</p>
          <pre>{error.message}</pre>
          <div className="crash-actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => this.setState({ error: null })}
            >
              尝试继续
            </button>
          </div>
        </div>
      </div>
    );
  }
}
