import { useEffect, type ReactNode } from 'react';
import { X } from './Icons';
import { haptic } from '../telegram';

/**
 * A modal panel that slides in from an edge, over a dimmed backdrop.
 *
 * Two edges, because Aside uses two: `bottom` for the transient sheets a
 * tap opens (sources, a file), `right` for the session sidebar. Both are
 * dismissed by the backdrop, by the close button, and by Escape.
 */
export function Sheet({
  side,
  title,
  subtitle,
  onClose,
  children,
}: {
  side: 'bottom' | 'right';
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = () => {
    haptic('soft');
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // One tap of feedback on the way in; the way out is on whichever
  // dismissal path actually fires (backdrop, close button, or Escape).
  useEffect(() => {
    haptic('soft');
  }, []);

  return (
    <div className="sheet-layer">
      <div className="sheet-backdrop" onClick={close} />
      <section className={`sheet sheet-${side}`} role="dialog" aria-label={title}>
        <header className="sheet-head">
          <div className="sheet-titles">
            <span className="sheet-title">{title}</span>
            {subtitle ? <span className="sheet-subtitle">{subtitle}</span> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}
