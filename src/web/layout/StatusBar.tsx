export interface StatusBarProps {
  words: number
  chars: number
}

/**
 * Counts for the open note. Commit and Push describe the vault separately.
 */
export function StatusBar(props: StatusBarProps) {
  return (
    <span class="ink-statusbar-counts">
      <span>{props.words} words</span>
      <span>{props.chars} chars</span>
    </span>
  )
}
