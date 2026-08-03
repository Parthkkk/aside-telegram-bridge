/**
 * A read-only list of the account's scheduled routines.
 *
 * Genuinely read-only, not just presented that way: `aside.routines`
 * exposes `list`/`get` and nothing else (verified against the live daemon,
 * plan section 1.4). There is no pause/resume/edit control here because
 * there is no request this server could make that would do one -- that
 * would need a full `aside exec` turn calling the `routine_update` tool,
 * which is a different cost model and out of scope for this screen.
 *
 * `RoutineRow` is typed as `{ [key: string]: unknown }` because the shape
 * is whatever the facade hands back; every field below is read
 * defensively rather than assumed.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, Spinner } from './Icons';
import { api } from '../api';
import type { RoutineRow } from '../types';

function str(row: RoutineRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value ? value : null;
}

function RoutineCard({ row }: { row: RoutineRow }) {
  const name = str(row, 'name') || 'Unnamed routine';
  const schedule =
    str(row, 'schedule') ||
    str(row, 'rrule') ||
    str(row, 'runAt') ||
    (typeof row.scheduleKind === 'string' ? row.scheduleKind : null);
  const state = str(row, 'state');
  const nextRun =
    str(row, 'nextRun') || str(row, 'next_run') || str(row, 'nextRunAt');

  return (
    <div className="panel-row routine-row">
      <span className="panel-row-name">{name}</span>
      {schedule ? <span className="settings-row-description">{schedule}</span> : null}
      {nextRun ? (
        <span className="settings-row-description">Next: {nextRun}</span>
      ) : null}
      {state ? <span className="settings-readout">{state}</span> : null}
    </div>
  );
}

export function RoutinesList({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<RoutineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.routines().then(
      (res) => alive && setRows(res.routines),
      (err) => alive && setError((err as Error).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app settings-screen">
      <header className="thread-header">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">Routines</span>
        </span>
      </header>
      <div className="settings-scroll">
        <p className="settings-note">
          Read-only -- create or edit routines from Aside on your computer.
        </p>
        {error ? <p className="list-empty">{error}</p> : null}
        {!rows && !error ? (
          <p className="list-empty">
            <Spinner size={14} /> Loading…
          </p>
        ) : null}
        {rows && rows.length === 0 ? (
          <p className="list-empty">No routines.</p>
        ) : null}
        {rows?.map((row, index) => (
          <RoutineCard key={str(row, 'id') || index} row={row} />
        ))}
      </div>
    </div>
  );
}
