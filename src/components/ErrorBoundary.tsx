import React from "react";

interface Props {
  children: React.ReactNode;
  onReset?: () => void;
}
interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  reset = () => {
    this.setState({ hasError: false, message: "" });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty-state" data-testid="error-boundary">
          <h1><span className="accent">Net</span>Comix</h1>
          <p>Something went wrong.</p>
          <pre style={{ fontSize: "0.75rem", opacity: 0.5, maxWidth: "80vw", overflow: "auto" }}>
            {this.state.message}
          </pre>
          <button className="btn" onClick={this.reset}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
