import {
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
  type TouchEvent,
  type MouseEvent,
} from 'react';
import { IonIcon } from '@ionic/react';
import { closeOutline } from 'ionicons/icons';

export interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  headerBadge?: ReactNode;
  footer?: ReactNode;
}

export function BottomSheet({
  isOpen,
  onClose,
  title,
  subtitle,
  headerBadge,
  footer,
  children,
}: PropsWithChildren<BottomSheetProps>) {
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);
  const startYRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setDragOffsetY(0);
      setIsDraggingSheet(false);
      startYRef.current = null;
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (!touch) return;
    startYRef.current = touch.clientY;
    setIsDraggingSheet(true);
  };

  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (startYRef.current === null) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaY = Math.max(0, touch.clientY - startYRef.current);
    setDragOffsetY(deltaY);
  };

  const handleTouchEnd = () => {
    if (dragOffsetY > 80) {
      setDragOffsetY(0);
      setIsDraggingSheet(false);
      startYRef.current = null;
      onClose();
      return;
    }
    setDragOffsetY(0);
    setIsDraggingSheet(false);
    startYRef.current = null;
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    startYRef.current = e.clientY;
    setIsDraggingSheet(true);

    const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
      if (startYRef.current === null) return;
      const deltaY = Math.max(0, moveEvent.clientY - startYRef.current);
      setDragOffsetY(deltaY);
    };

    const onMouseUp = (upEvent: globalThis.MouseEvent) => {
      const deltaY = startYRef.current !== null ? upEvent.clientY - startYRef.current : 0;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      startYRef.current = null;
      setIsDraggingSheet(false);
      setDragOffsetY(0);
      if (deltaY > 80) {
        onClose();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      className="bottom-sheet-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Task Details'}
    >
      <div
        className={`bottom-sheet-panel ${isDraggingSheet ? 'is-dragging' : ''}`}
        style={
          dragOffsetY > 0
            ? {
                transform: `translateY(${dragOffsetY}px)`,
                transition: isDraggingSheet ? 'none' : undefined,
              }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag Handle Area */}
        <div
          className="bottom-sheet-handle-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={handleMouseDown}
          title="Drag down to close"
        >
          <span className="bottom-sheet-handle-pill" />
        </div>

        {/* Sheet Header */}
        <div className="bottom-sheet-header">
          <div className="bottom-sheet-header__info">
            {headerBadge && <div className="bottom-sheet-header__badges">{headerBadge}</div>}
            {title && <h4 className="bottom-sheet-title">{title}</h4>}
            {subtitle && <small className="bottom-sheet-subtitle">{subtitle}</small>}
          </div>
          <button
            type="button"
            className="react-modal-close-btn"
            onClick={onClose}
            aria-label="Close bottom sheet"
          >
            <IonIcon icon={closeOutline} />
          </button>
        </div>

        {/* Sheet Scrollable Body */}
        <div className="bottom-sheet-body">{children}</div>

        {/* Optional Sticky Footer */}
        {footer && <div className="bottom-sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
