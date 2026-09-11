import type { ReactNode } from 'react';

/** Label + control + error/hint line, wired for screen readers via `${id}-msg`. */
export default function Field({
  id,
  label,
  error,
  hint,
  className = '',
  children,
}: {
  id: string;
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
