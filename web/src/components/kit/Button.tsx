import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger-text' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` only for the one main action per view. A disabled primary keeps
   * a label that says why ("Decide every item first"). `danger` is the
   * solid confirm button inside a destructive dialog.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children?: ReactNode;
}

/** UI_SPEC §4 Button: 30px tall (small 28px). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', variant !== 'default' && variant, size === 'sm' && 'sm', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: every icon button has an accessible name (UI_SPEC §11). */
  'aria-label': string;
  icon: IconName;
  /** No border (the open-item tab ×, dialog close). */
  bare?: boolean;
}

/** UI_SPEC §4 IconButton: 32×32. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, bare = false, className, type = 'button', title, ...rest },
  ref,
) {
  const cls = ['iconbtn', bare && 'bare', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} title={title ?? rest['aria-label']} {...rest}>
      <Icon name={icon} />
    </button>
  );
});

/**
 * A segmented control (Work layouts, Settings client setup). An option can
 * be `disabled`; `describedBy` then names the element that says why
 * (the packet's "Keep it for" without an epic, decision 35).
 */
export function SegmentedControl<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: K; label: string; disabled?: boolean; describedBy?: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          disabled={o.disabled || undefined}
          aria-describedby={o.describedBy}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A saved-filter chip with a count (Work filter row). Zero counts are hidden by the caller. */
export function FilterChip({
  label,
  count,
  pressed,
  title,
  onClick,
}: {
  label: string;
  count?: number;
  pressed: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="fchip" aria-pressed={pressed} title={title} onClick={onClick}>
      {label}
      {count !== undefined && <b>{count}</b>}
    </button>
  );
}
