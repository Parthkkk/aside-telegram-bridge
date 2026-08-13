import { useRef, useState } from 'react';
import { Popover } from './Popover';
import { formatTokens } from '../utils/format';
import { haptic } from '../telegram';

/**
 * How full the session's context window is.
 *
 * This ring sits next to the model pill and used to be read -- by us, and
 * so by the app -- as a busy spinner. It is not: Aside draws a circular
 * progress meter here, and its tooltip says so. Busy-ness now lives in the
 * streaming footer, and this never animates.
 *
 * A session with no assistant message yet has no usage to report, and so
 * this renders NOTHING rather than an empty circle. The empty state was
 * indistinguishable from a stalled spinner -- a grey ring sitting in the
 * control row next to a real one, reporting nothing and looking broken.
 * A meter with no reading is not a neutral default, it is noise.
 */
export function ContextRing({
  used,
  window: contextWindow,
  size = 15,
}: {
  used: number;
  window: number;
  size?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const fraction = contextWindow > 0 ? Math.min(1, used / contextWindow) : 0;
  const percent = Math.round(fraction * 100);
  const radius = 6.25;
  const circumference = 2 * Math.PI * radius;

  // Nothing measured yet: show nothing. The ring appears on the first turn
  // that actually consumes context.
  if (!(contextWindow > 0) || used <= 0) return null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="context-ring"
        aria-label={`Context window ${percent}% full`}
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            opacity="0.25"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray={`${circumference * fraction} ${circumference}`}
            // Start the arc at twelve o'clock, like Aside's.
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>

      {open && ref.current ? (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <div className="context-tip">
            <p>Context window: {percent}% full</p>
            <p>
              {formatTokens(used)} / {formatTokens(contextWindow)} tokens used
            </p>
            <p className="context-tip-note">
              Aside automatically compacts its context
            </p>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
