/**
 * A thread, drawn the way the sidepanel draws one.
 *
 * User messages are light grey rounded bubbles. The assistant's answer is
 * plain markdown on the page background -- no bubble, no card, no avatar.
 *
 * Work is the interesting part. While a turn is running its steps are on
 * the page, live; the moment the final answer starts arriving they fold
 * into a single `Worked for …` row above it. `foldIsLive` below is that
 * rule: a running fold stays open until either the streamed answer has
 * begun or the transcript has already promoted an answer out of it. Mid-turn
 * commentary does not trigger it, because commentary is followed by more
 * tool calls, which clears the stream buffer and reopens the timeline.
 *
 * Two of these items never come from the transcript:
 *
 *  - a `pending` user bubble, appended the moment Send is tapped so the
 *    message is visible immediately, and dimmed until the transcript
 *    confirms it;
 *  - a `streaming` block, the answer as the CLI is writing it. It goes
 *    through the same markdown renderer as the finished answer so there is
 *    no reflow when the two swap.
 */
import { useRef, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  Attachment,
  ChildSteps,
  CitationSource,
  ThreadItem,
} from '../types';
import { FileIcon } from './Icons';
import { Markdown } from './Markdown';
import { WorkFold } from './WorkFold';
import { ErrorCard } from './ErrorCard';
import { QuestionCard } from './QuestionCard';
import { PressReveal } from './PressReveal';
import type { CitationMark } from '../utils/citations';

function BubbleAttachments({ files }: { files: Attachment[] }) {
  return (
    <span className="bubble-files">
      {files.map((file, index) => (
        <span className="bubble-file" key={`${file.name}-${index}`}>
          <FileIcon size={12} strokeWidth={1.75} />
          {file.name}
        </span>
      ))}
    </span>
  );
}

/**
 * Whether the fold at `index` should still be showing its timeline.
 *
 * The rule, and the bug it replaces.
 *
 * The old rule was "live until any answer or streaming item follows". That
 * looks right and is not, because a `streaming` item is just whatever the
 * CLI has written to stdout -- and the agent narrates MID-TURN, between
 * tool calls, all the time. Every paragraph of commentary therefore
 * collapsed the timeline; the next tool call cleared the stream buffer and
 * re-opened it. On a chatty turn that is a fold flapping open and shut
 * several times a minute, which is exactly the reported "doesn't reliably
 * auto-expand, collapse is flaky".
 *
 * What actually distinguishes commentary from the final answer is whether
 * the agent is still doing anything. Commentary is followed by more work,
 * so a step in the block is still pending; the final answer only starts
 * once every step has its result. So:
 *
 *  - not running          -> not live (a finished turn opens collapsed)
 *  - a real `answer` item -> not live (the transcript has settled it)
 *  - streaming text while a step is still in flight -> LIVE (commentary)
 *  - streaming text with every step settled          -> not live (answer)
 *
 * Exported and tested directly; it is a state machine, not a detail.
 */
export function foldIsLive(items: ThreadItem[], index: number): boolean {
  const block = items[index];
  if (block.kind !== 'work' || !block.running) return false;

  const after = items.slice(index + 1);
  // The transcript has promoted an answer out of this turn: it is over.
  if (after.some((item) => item.kind === 'answer')) return false;
  // A question ends the turn too -- the card below is the point of it.
  if (after.some((item) => item.kind === 'question')) return false;

  if (!after.some((item) => item.kind === 'streaming')) return true;

  // Streaming, so decide whether it is commentary or the answer.
  return block.items.some(
    (item) => item.kind === 'step' && item.status === 'pending',
  );
}

export interface ThreadProps {
  items: ThreadItem[];
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  sources: Record<string, CitationSource>;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  onOpenCitation: (mark: CitationMark) => void;
  /** Send a question's chosen option as a follow-up message. */
  onAnswer?: (header: string, label: string) => Promise<void>;
  /**
   * Start a new session from a question only the desktop can answer.
   *
   * The card offers this instead of a dead read-only notice; see
   * `QuestionCard`.
   */
  onRecover?: (label: string) => Promise<void>;
  /** A send is in flight, so question cards hold their buttons. */
  busy?: boolean;
  /**
   * The SAME element App.tsx already scrolls (`.thread-scroll`, ref
   * `scroller` there) and pins to the bottom of during streaming.
   *
   * Virtualization needs to know the real scroll container to measure
   * against, but it must not become a SECOND scrollable element -- Day 1
   * plan 5.7 asks for the existing container to stay the only one, and
   * App.tsx's own pin-to-bottom effect (`el.scrollTop = el.scrollHeight`)
   * already assumes there is exactly one. react-virtual is fine with this:
   * it only needs a ref to the scrolling ancestor, not ownership of it.
   */
  scrollElementRef: RefObject<HTMLDivElement | null>;
}

/**
 * A rendered thread item does not carry its own key/height -- `Thread`
 * used to be a flat `.map()`. Pulled out unchanged into its own function so
 * the virtualizer can call it per visible row instead of for the whole
 * list at once.
 */
function renderItem(
  item: ThreadItem,
  index: number,
  items: ThreadItem[],
  props: ThreadProps,
) {
  if (item.kind === 'user') {
    return (
      <PressReveal
        className="turn turn-user"
        text={item.text}
        align="end"
        // Not while pending. A message that has not come back from the
        // transcript yet can still fail, and offering to copy it implies
        // it is a settled part of the conversation.
        enabled={!item.pending}
      >
        <div className={`user-bubble ${item.pending ? 'is-pending' : ''}`}>
          {item.attachments?.length ? (
            <BubbleAttachments files={item.attachments} />
          ) : null}
          {item.text}
        </div>
      </PressReveal>
    );
  }
  if (item.kind === 'work') {
    return (
      <WorkFold
        block={item}
        sessionId={props.sessionId}
        live={foldIsLive(items, index)}
        subagentSteps={props.subagentSteps}
        onInspectSubagent={props.onInspectSubagent}
        sources={props.sources}
        onOpenCitation={props.onOpenCitation}
      />
    );
  }
  if (item.kind === 'error') {
    return <ErrorCard alert={item.alert} />;
  }
  if (item.kind === 'question') {
    return (
      <QuestionCard
        item={item}
        busy={props.busy}
        onAnswer={props.onAnswer}
        onRecover={props.onRecover}
      />
    );
  }
  const streaming = item.kind === 'streaming';
  return (
    <PressReveal
      className="turn turn-answer"
      text={item.text}
      // No hold on a streaming block. The text is still arriving, so a copy
      // taken now is a truncated answer.
      enabled={!streaming}
    >
      <div className="answer">
        <Markdown
          text={item.text}
          streaming={streaming}
          sources={props.sources}
          sessionId={props.sessionId}
          onOpenCitation={props.onOpenCitation}
        />
      </div>
    </PressReveal>
  );
}

export function Thread(props: ThreadProps) {
  const { items } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Item heights vary enormously -- a one-line answer next to a work fold
   * with a whole tool-call timeline -- so this is dynamic measurement, not
   * a fixed row height. `estimateSize` only has to be a plausible guess for
   * the FIRST layout pass; `measureElement` (wired below via the ref
   * callback) corrects it against the real rendered height afterward, and
   * on every resize (a streaming answer growing token by token included --
   * that resizes the mounted element, which triggers react-virtual's own
   * ResizeObserver).
   *
   * `overscan: 6` and `scrollMargin` matching this component's own offset
   * within `.thread-scroll` are both from the Day 1 plan's 5.7. The offset
   * matters because `.thread-scroll` can render a loading/error paragraph
   * ABOVE this component -- without `scrollMargin` the virtualizer would
   * assume its content starts at the scroll container's own top edge.
   */
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => props.scrollElementRef.current,
    estimateSize: () => 80,
    overscan: 6,
    getItemKey: (index) => items[index].id,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="thread" ref={containerRef}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: virtualizer.getTotalSize(),
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${
                  virtualRow.start - virtualizer.options.scrollMargin
                }px)`,
              }}
            >
              {renderItem(item, virtualRow.index, items, props)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
