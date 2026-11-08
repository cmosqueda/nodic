import { type PropsWithChildren } from 'react';
import { IonIcon } from '@ionic/react';
import { closeOutline } from 'ionicons/icons';
export { BottomSheet, type BottomSheetProps } from './BottomSheet';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
}

export function Modal({ isOpen, onClose, title, children }: PropsWithChildren<ModalProps>) {
  if (!isOpen) return null;

  return (
    <div className="react-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="react-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="react-modal-header">
          <h4>{title}</h4>
          <button className="react-modal-close-btn" onClick={onClose} aria-label="Close dialog">
            <IonIcon icon={closeOutline} />
          </button>
        </div>
        <div className="react-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

interface AlertProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  confirmDestructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  confirmDestructive = false,
  onConfirm,
  onCancel,
}: AlertProps) {
  if (!isOpen) return null;

  return (
    <div className="react-modal-overlay" onClick={onCancel} role="alertdialog" aria-modal="true">
      <div className="react-modal-dialog react-alert-dialog" onClick={(e) => e.stopPropagation()}>
        <h4 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>{title}</h4>
        <p style={{ margin: '10px 0 16px', color: 'var(--nodic-muted)', fontSize: '13px', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button className="dialog-btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={confirmDestructive ? 'dialog-btn-danger' : 'dialog-btn-primary'}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
