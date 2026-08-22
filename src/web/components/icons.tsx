import type { JSX } from 'preact'
import './icons.css'

interface IconProps { class?: string; title?: string; size?: number }

function svg(children: JSX.Element, props: IconProps, extra = ''): JSX.Element {
  const cls = ['ink-icon', extra, props.class ?? ''].filter(Boolean).join(' ')
  const sz = props.size ?? 18
  return (
    <svg
      class={cls}
      width={sz} height={sz} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : 'true'}
    >
      {props.title ? <title>{props.title}</title> : null}
      {children}
    </svg>
  )
}

/* The line in these two is the panel's own edge, which is why it is the part that moves. */
export const IconSidebar = (p: IconProps) =>
  svg(
    <><rect x="3" y="4" width="18" height="16" rx="1.5" /><line class="ink-panel-edge" x1="9" y1="4" x2="9" y2="20" /></>,
    p,
    'ink-icon-panel ink-icon-panel--left',
  )

export const IconRightPanel = (p: IconProps) =>
  svg(
    <><rect x="3" y="4" width="18" height="16" rx="1.5" /><line class="ink-panel-edge" x1="15" y1="4" x2="15" y2="20" /></>,
    p,
    'ink-icon-panel ink-icon-panel--right',
  )

export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.52 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.52-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    p,
    'ink-icon-gear',
  )

/** Sidebar switcher: the file view. Overlapping documents — the only stacked silhouette in
 *  the set, so it cannot be confused with the folder used by IconNewFolder. */
export const IconFiles = (p: IconProps) =>
  svg(
    <>
      <rect class="ink-files-front" x="3" y="7" width="13" height="14" rx="1.5" />
      <path class="ink-files-back" d="M7 7V4.5A1.5 1.5 0 0 1 8.5 3H17l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5H16" />
    </>,
    p,
    'ink-icon-files',
  )

/** Sidebar switcher: the outline view. A staircase of bars reads as hierarchy at 18px,
 *  where a tree glyph with nodes turns to mush. */
export const IconOutline = (p: IconProps) =>
  svg(
    <>
      <line class="ink-outline-b1" x1="4" y1="7" x2="20" y2="7" />
      <line class="ink-outline-b2" x1="9" y1="12" x2="20" y2="12" />
      <line class="ink-outline-b3" x1="14" y1="17" x2="20" y2="17" />
    </>,
    p,
    'ink-icon-outline',
  )

/**
 * The agent: a prompt.
 *
 * Was a speech bubble with a caret inside it, and it was the wrong weight for the row it sits in.
 * Rendered beside Outline, History and Commit the difference is obvious — those are wide, open and
 * built from straight lines across the whole box, and the bubble was a small dense shape with
 * detail too fine to read at 20px.
 *
 * A bubble also collides with History's rectangle, which is its immediate neighbour in the phone
 * menu. This is two strokes, spans the box, and says the true thing: you type, it answers.
 */
export const IconAgent = (p: IconProps) =>
  svg(
    <>
      <path class="ink-agent-caret" d="M4.5 8 8.5 12l-4 4" />
      <line x1="11.5" y1="16" x2="19.5" y2="16" />
    </>,
    p,
    'ink-icon-agent',
  )

/** A plain document. Used in labelled menus, where the word "New" carries the action and a
 *  plus on the glyph would only repeat it — and would be the first thing to blur at 15px. */
export const IconFile = (p: IconProps) =>
  svg(
    <>
      <path d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3v5.5H19" />
    </>,
    p,
  )

/** A plain folder, for the same reason as IconFile. */
export const IconFolder = (p: IconProps) =>
  svg(
    <>
      <path d="M3 18.5V6A1.5 1.5 0 0 1 4.5 4.5H9l2 3h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </>,
    p,
  )

/** The sidebar header's create trigger. A bare cross carries no container outline, so it sits
 *  at the same stroke density as the rest of the set. */
export const IconPlus = (p: IconProps) =>
  svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    p,
  )

/** The per-row overflow trigger. Filled dots rather than strokes: at 16px a stroked ring
 *  closes up into a blob. */
export const IconMore = (p: IconProps) =>
  svg(
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>,
    p,
  )

/** A link, because that is what sharing produces here — not an outbound arrow, which means "open". */
/**
 * Sharing produces a link, so this is a link — but level, not on the diagonal.
 *
 * The old one was Feather's, and it was the only diagonal in a set that is otherwise square to the
 * grid, drawn small and tight where the others are wide and open. Same meaning, same vocabulary as
 * its neighbours.
 */
export const IconShare = (p: IconProps) =>
  svg(
    <>
      <path d="M10 8H6.5a4 4 0 0 0 0 8H10" />
      <path d="M14 8h3.5a4 4 0 0 1 0 8H14" />
      <line x1="8.5" y1="12" x2="15.5" y2="12" />
    </>,
    p,
  )

export const IconRename = (p: IconProps) =>
  svg(
    <>
      <path d="M4 20l1.2-4.2L15.8 5.2a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L8.2 18.8z" />
      <path d="M14.2 6.8l3 3" />
    </>,
    p,
  )

export const IconTrash = (p: IconProps) =>
  svg(
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 6.5v12A1.5 1.5 0 0 0 8 20h8a1.5 1.5 0 0 0 1.5-1.5v-12" />
    </>,
    p,
  )

export const IconPushArrow = (p: IconProps) =>
  svg(<><line x1="12" y1="19" x2="12" y2="6" /><path d="M6 11l6-6 6 6" /></>, p)

export const IconCommit = (p: IconProps) =>
  svg(<><line x1="3" y1="12" x2="21" y2="12" /><circle cx="12" cy="12" r="3.5" /></>, p)

export const IconGitBranch = (p: IconProps) =>
  svg(<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M6 8.5v7" /><path d="M8.5 6q5 0 7 4.5" /></>, p)

export const IconUnsavedDot = (p: IconProps) => (
  <svg
    class={['ink-unsaved-dot', p.class ?? ''].filter(Boolean).join(' ')}
    width="8" height="8" viewBox="0 0 8 8"
    role="img"
    aria-label={p.title ?? 'Unsaved'}
  >
    {p.title ? <title>{p.title}</title> : null}
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
)

/* Read-only / edit toggle. The button shows the mode it is currently IN, so the pair has to be
   readable against each other at 18px rather than merely recognisable alone. Neither carries a
   slash or a padlock — the state is a posture, not a permission.

   The page glyph is a third rounded rectangle in a row that already holds two panel toggles, so
   its interior does the separating: three text rules and a shorter last line, which neither
   panel icon has. Judged in the real top bar, in both themes, at render size. */
export const IconEditMode = (p: IconProps) =>
  svg(
    <>
      <path d="M5 19l2.2-6.6L15 4.6l4.4 4.4-7.8 7.8z" />
      <path d="M9.4 14.6l5.2-5.2" />
      <path d="M5 19l3.1-1.1" />
    </>,
    p,
    'ink-icon-nib',
  )

export const IconReadMode = (p: IconProps) =>
  svg(
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <line x1="8.5" y1="9" x2="15.5" y2="9" />
      <line x1="8.5" y1="12.5" x2="15.5" y2="12.5" />
      <line class="ink-page-tail" x1="8.5" y1="16" x2="13" y2="16" />
    </>,
    p,
    'ink-icon-page',
  )

/* The source/rendered pair.
 *
 * Deliberately not another bordered page: IconReadMode is already a page with three ruled lines,
 * and a second one beside it read as the same control twice. These say *markup* against *prose* —
 * angle brackets for the source, and unruled lines of uneven length for the rendered document,
 * with no frame around them.
 *
 * Each has a moving part, like the rest of the bar: the brackets open, and the heading line runs
 * out to the measure. */
export const IconSource = (p: IconProps) =>
  svg(
    <>
      <polyline class="ink-bracket ink-bracket--left" points="9.5,7.5 5,12 9.5,16.5" />
      <polyline class="ink-bracket ink-bracket--right" points="14.5,7.5 19,12 14.5,16.5" />
    </>,
    p,
    'ink-icon-brackets',
  )

export const IconRendered = (p: IconProps) =>
  svg(
    <>
      <line class="ink-prose-head" x1="4" y1="7" x2="12" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="16" y2="17" />
    </>,
    p,
    'ink-icon-prose',
  )

/* Back, for the phone's push navigation. A chevron rather than an arrow: it points at the screen
   behind this one rather than describing a direction of travel. */
export const IconBack = (p: IconProps) =>
  svg(<polyline points="14.5,5.5 8,12 14.5,18.5" />, p, 'ink-icon-back')

/* Close. A cross rather than a chevron: this dismisses a dialog rather than going back a screen. */
export const IconClose = (p: IconProps) =>
  svg(<><path d="M6.5 6.5l11 11" /><path d="M17.5 6.5l-11 11" /></>, p, 'ink-icon-close')

/* Search.
 *
 * Drawn rather than borrowed, like the rest of the set: a 7-radius lens on the same 24 grid as
 * everything else, with the handle leaving the rim at 45° so the two strokes meet cleanly at this
 * size. The handle is its own path so it can move — on focus it extends, which is the one moment
 * the field is doing something. */
export const IconSearch = (p: IconProps) =>
  svg(
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path class="ink-lens-handle" d="M15.4 15.4L20 20" />
    </>,
    p,
    'ink-icon-lens',
  )

/* A picture: the frame, a sun, and the hill that tells you the frame is not a window. */
export const IconPicture = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M4 16.5l4.5-4 3.5 3 3-2.5 5 4.5" />
    </>,
    p,
  )

/* The camera, which is the picture's frame turned into a body with a lens and a shutter bump. */
export const IconCamera = (p: IconProps) =>
  svg(
    <>
      <path d="M3 8.5h3.5L8 6h8l1.5 2.5H21v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </>,
    p,
  )

/* Paste: the sheet, and the clip that says where it came from. */
export const IconClipboard = (p: IconProps) =>
  svg(
    <>
      <path d="M9 4.5H7A1.5 1.5 0 0 0 5.5 6v13A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 17 4.5h-2" />
      <rect x="9" y="3" width="6" height="3.2" rx="1" />
    </>,
    p,
  )
