/**
 * Two-page horizontal pager driven by touch.
 *
 * The home screen already owns the vertical axis: it is a scroll-snapping
 * scroller where a swipe up reveals Recents. Adding a second page sideways
 * means the two gestures share a surface, so the only hard requirement here
 * is that this never steals a scroll.
 *
 * It does that by staying passive until direction is unambiguous. A touch
 * is not claimed on the first pixel of movement; it is claimed once the
 * pointer has travelled far enough horizontally AND horizontal travel
 * clearly dominates vertical. Until then the browser scrolls normally. Once
 * a gesture has been resolved as vertical, it can never later be
 * reinterpreted as horizontal, which is what stops a diagonal flick from
 * yanking the page sideways halfway through a scroll.
 */
import { useCallback, useRef, useState } from 'react';

/** Horizontal travel before a gesture is considered a page drag. */
const CLAIM_PX = 14;
/** How much horizontal must beat vertical to be read as a sideways intent. */
const DOMINANCE = 1.4;
/** Fraction of the width past which a release settles on the next page. */
const COMMIT_RATIO = 0.32;
/** Velocity (px/ms) that commits regardless of distance. */
const FLICK_VELOCITY = 0.45;

export interface SidePager {
  /** 0 = primary page, 1 = side page. */
  page: 0 | 1;
  open: () => void;
  close: () => void;
  /** Live drag offset in px, 0 when not dragging. */
  offset: number;
  dragging: boolean;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
}

export function useSidePager(
  /** Called when the page actually changes, for haptics. */
  onSettle?: (page: 0 | 1) => void,
): SidePager {
  const [page, setPage] = useState<0 | 1>(0);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  // null = undecided, 'x' = ours, 'y' = the scroller's. Once set, final.
  const axis = useRef<null | 'x' | 'y'>(null);
  const width = useRef(1);

  const settle = useCallback(
    (next: 0 | 1) => {
      setPage((prev) => {
        if (prev !== next) onSettle?.(next);
        return next;
      });
      setOffset(0);
      setDragging(false);
    },
    [onSettle],
  );

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      start.current = null;
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    axis.current = null;
    width.current = e.currentTarget.clientWidth || window.innerWidth || 1;
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const s = start.current;
      if (!s || axis.current === 'y') return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;

      if (axis.current === null) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < CLAIM_PX && ay < CLAIM_PX) return;
        if (ax < ay * DOMINANCE) {
          // Vertical, and permanently so for this touch.
          axis.current = 'y';
          return;
        }
        /*
         * Only claim a horizontal gesture that has somewhere to go. On the
         * primary page that is a leftward drag (pulling the side page in);
         * on the side page, a rightward one. Claiming the other direction
         * would swallow the gesture and render as a dead zone.
         */
        const useful = page === 0 ? dx < 0 : dx > 0;
        if (!useful) {
          axis.current = 'y';
          return;
        }
        axis.current = 'x';
        setDragging(true);
      }

      // Clamp so the panel cannot be dragged past either edge.
      const raw = page === 0 ? dx : dx - width.current;
      const clamped = Math.max(-width.current, Math.min(0, raw));
      setOffset(clamped + (page === 0 ? 0 : width.current));
    },
    [page],
  );

  const finish = useCallback(() => {
    const s = start.current;
    start.current = null;
    if (axis.current !== 'x') {
      axis.current = null;
      return;
    }
    axis.current = null;
    const travelled = Math.abs(offset);
    const elapsed = Math.max(1, Date.now() - (s?.t ?? Date.now()));
    const velocity = travelled / elapsed;
    const past = travelled > width.current * COMMIT_RATIO;
    const flicked = velocity > FLICK_VELOCITY && travelled > 24;
    const commit = past || flicked;
    settle(commit ? (page === 0 ? 1 : 0) : page);
  }, [offset, page, settle]);

  return {
    page,
    open: () => settle(1),
    close: () => settle(0),
    offset,
    dragging,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: finish,
      onTouchCancel: finish,
    },
  };
}
