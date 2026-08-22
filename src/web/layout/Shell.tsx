import type { ComponentChildren } from 'preact'
import {
  isPhone,
  leftPanelOpen,
  phoneScreen,
  phoneSheet,
  phoneSwiping,
  rightPanelOpen,
  showPhoneList,
} from '../state/ui.js'
import { useSwipeBack } from './useSwipeBack.js'
import './shell.css'

export interface ShellProps {
  topBar: ComponentChildren
  /** The same bar in its list form, for the copy that rides in on a phone's back-swipe. */
  listTopBar?: ComponentChildren
  left: ComponentChildren
  center: ComponentChildren
  right: ComponentChildren
  statusBar: ComponentChildren
}

/**
 * The application grid.
 *
 * There is no `.ink-body` wrapper: the sidebar has to be a direct grid item of `.ink-shell`
 * to span the body and status rows, and a wrapper would prevent that. The right drawer
 * lives inside `.ink-center`, which is already its positioning ancestor.
 */
export function Shell(props: ShellProps) {
  // Swipe right on the document to go back to the list. Not live while a sheet covers it: the
  // outline and history sit on top, and a drag underneath them belongs to nothing.
  const swipe = useSwipeBack({
    enabled: () => isPhone.value && phoneScreen.value === 'document' && phoneSheet.value === null,
    onBack: showPhoneList,
    onDragging: (dragging) => { phoneSwiping.value = dragging },
  })

  // One screen at a time. The same children in the same order — only one of the two panes is
  // mounted, so nothing has to be built twice and the document keeps its state across a trip to
  // the list and back.
  if (isPhone.value) {
    const onList = phoneScreen.value === 'list'
    // The list is mounted for the length of a back-swipe as well as on its own screen: it is what
    // slides in, over a document that does not move. They share one grid cell, list on top.
    const swiping = phoneSwiping.value
    return (
      <div class="ink-shell ink-shell--phone">
        <header class="ink-topbar">{props.topBar}</header>
        {(onList || swiping) && (
          <aside class={`ink-left${swiping ? ' ink-left--sliding' : ''}`} ref={swipe.reveal}>
            {/* The arriving menu brings its own header. Without it the panel starts below the
                document's bar and reads as a screen with its top cut off. */}
            {swiping && <header class="ink-topbar">{props.listTopBar}</header>}
            {props.left}
          </aside>
        )}
        {!onList && (
          <main class="ink-center" ref={swipe.listen}>
            {props.center}
            {rightPanelOpen.value && <aside class="ink-right">{props.right}</aside>}
          </main>
        )}
        <footer class="ink-statusbar">{props.statusBar}</footer>
      </div>
    )
  }

  return (
    <div
      class={`ink-shell${leftPanelOpen.value ? '' : ' ink-shell--no-left'}`}
    >
      <header class="ink-topbar">{props.topBar}</header>
      {leftPanelOpen.value && <aside class="ink-left">{props.left}</aside>}
      {/* The drawer floats, so it takes no space in this grid — but the document has to know it
          is there, because the text gives way to it rather than being overlapped by it. See
          `document-column.css`. */}
      <main class={`ink-center${rightPanelOpen.value ? ' ink-center--drawer' : ''}`}>
        {props.center}
        {rightPanelOpen.value && <aside class="ink-right">{props.right}</aside>}
      </main>
      <footer class="ink-statusbar">{props.statusBar}</footer>
    </div>
  )
}
