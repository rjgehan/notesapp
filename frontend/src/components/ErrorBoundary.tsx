// Catches unexpected render errors per view and offers "Reload view" (DESIGN §6.20).
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[notesapp] ${this.props.label} crashed`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">Something went wrong in this {this.props.label}.</p>
        <p className="error-panel-detail">{this.state.error.message}</p>
        <button type="button" className="button" onClick={this.reset}>
          Reload view
        </button>
      </div>
    );
  }
}
