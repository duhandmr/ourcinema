import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CenteredCard } from './CenteredCard';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[OurCinema] Beklenmeyen hata:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <CenteredCard
          title="Bir şeyler ters gitti"
          description="Beklenmeyen bir hata oluştu. Sayfayı yenileyerek devam edebilirsiniz."
        >
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition hover:bg-accent-hover"
          >
            Sayfayı yenile
          </button>
        </CenteredCard>
      );
    }
    return this.props.children;
  }
}
