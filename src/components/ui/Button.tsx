import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'success' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  active?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'default',
  active = false,
  fullWidth = false,
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    active && styles.active,
    variant === 'primary' && styles.primary,
    variant === 'success' && styles.success,
    variant === 'danger' && styles.danger,
    fullWidth && styles.fullWidth,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} className={classes}>
      {children}
    </button>
  );
}
