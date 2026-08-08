import type { ReactNode } from 'react';

/** The only surface in the system: flat panel background + 1px hard border. */
export function Panel({
  title,
  right,
  children,
  className = '',
  bodyClassName = 'p-3',
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">{title}</h2>
          {right}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
