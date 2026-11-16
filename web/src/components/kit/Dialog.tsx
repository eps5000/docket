import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonProps } from './Button';
import { IconButton } from './Button';
import { useFocusTrap } from './focus';

export interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /**
   * Destructive dialogs focus Cancel first (UI_SPEC §1.6, §4, §11). Mark the
   * Cancel button with `DialogCancel` (or `data-dialog-cancel`).
   */
  destructive?: boolean;
  /** An element to focus first instead (Quick capture focuses Title). */
  initialFocus?: () => HTMLElement | null;
  /** Wider content (Jira import). Still max 640px per UI_SPEC §4. */
  className?: string;
}

/**
 * UI_SPEC §4 Dialog: max 640px, overlay, 80px from the top; `role=dialog`,
 * `aria-modal`, labelled by its title; traps focus, closes on Esc, returns
 * focus to the trigger. Rendered while mounted: the caller decides when.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  destructive = false,
  initialFocus,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, {
    onEscape: onClose,
    initial: (root) => {
      const explicit = initialFocus?.();
      if (explicit) return explicit;
      if (destructive) return root.querySelector<HTMLElement>('[data-dialog-cancel]');
      return root.querySelector<HTMLElement>(
        '.body input, .body textarea, .body select, .body button, footer button',
      );
    },
  });
  const node = (
    <div
      className="ov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={['dlg', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-destructive={destructive || undefined}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="x" aria-label="Close" bare onClick={onClose} />
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}

/** The Cancel button of a dialog; a destructive dialog focuses it first. */
export function DialogCancel({ children = 'Cancel', ...rest }: ButtonProps) {
  return (
    <Button data-dialog-cancel="" {...rest}>
      {children}
    </Button>
  );
}
