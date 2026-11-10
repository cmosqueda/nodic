import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ErrorInfo,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { IonIcon } from '@ionic/react';
import { alertCircleOutline, checkmarkCircleOutline, informationCircleOutline } from 'ionicons/icons';

/* ---------- Spinner / loading ---------- */

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span className="nd-spinner" role="status" aria-label={label ?? 'Loading'} style={{ width: size, height: size }} />
  );
}

/** Full-screen splash shown while the local database loads. */
export function LoadingScreen({ message = 'Loading Nodic...' }: { message?: string }) {
  return (
    <div className="nd-splash" role="status" aria-live="polite">
      <div className="nd-splash__mark">
        <span className="nd-splash__node nd-splash__node--a" />
        <span className="nd-splash__node nd-splash__node--b" />
        <span className="nd-splash__link" />
      </div>
      <strong>{message}</strong>
    </div>
  );
}

/** Blocking progress dialog for work the user must wait for. */
export function BusyModal({ isOpen, message, detail }: { isOpen: boolean; message: string; detail?: string }) {
  if (!isOpen) return null;
  return (
    <div className="react-modal-overlay" role="alertdialog" aria-modal="true" aria-busy="true">
      <div className="react-modal-dialog nd-busy">
        <Spinner size={32} />
        <strong>{message}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="nd-skeleton-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="nd-skeleton-row">
          <span className="nd-skeleton nd-skeleton--avatar" />
          <span className="nd-skeleton-lines">
            <span className="nd-skeleton" />
            <span className="nd-skeleton nd-skeleton--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Button that shows a spinner and ignores clicks while its async action runs. */
export function BusyButton({
  busy,
  busyLabel,
  children,
  disabled,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button {...rest} className={className} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <Spinner size={14} /> {busyLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="nd-inline-error" role="alert">
      <IonIcon icon={alertCircleOutline} />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="dialog-btn-outline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/* ---------- Toasts + action runner ---------- */

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

interface FeedbackApi {
  success(message: string): void;
  error(message: string): void;
  info(message: string): void;
  /** Runs an async action, toasting its error (and optional success). Resolves true when it succeeded. */
  run(action: () => Promise<unknown>, options?: { success?: string; error?: string }): Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function FeedbackProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-2), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );

  // Last line of defence: promise rejections nobody handled become a visible message.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', e.reason);
      push('error', errorMessage(e.reason));
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [push]);

  const api = useMemo<FeedbackApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
      async run(action, options) {
        try {
          await action();
          if (options?.success) push('success', options.success);
          return true;
        } catch (err) {
          console.warn('Action failed:', err);
          push('error', options?.error ?? errorMessage(err));
          return false;
        }
      },
    }),
    [push],
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <div className="nd-toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`nd-toast nd-toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <IonIcon
              icon={
                t.kind === 'error'
                  ? alertCircleOutline
                  : t.kind === 'success'
                    ? checkmarkCircleOutline
                    : informationCircleOutline
              }
            />
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside FeedbackProvider');
  return ctx;
}

/* ---------- Error boundary ---------- */

interface BoundaryState {
  error: Error | null;
}

/** Keeps a render crash from turning the whole app into a blank screen. */
export class ErrorBoundary extends Component<PropsWithChildren<{ fallback?: ReactNode }>, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="nd-crash" role="alert">
        <IonIcon icon={alertCircleOutline} />
        <h3>Something went wrong</h3>
        <p>{this.state.error.message || 'An unexpected error occurred.'}</p>
        <div className="join-actions">
          <button className="dialog-btn-outline" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="dialog-btn-primary" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
