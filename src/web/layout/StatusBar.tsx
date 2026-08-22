export interface StatusBarProps {
  words: number
  chars: number
}

/**
 * Document-level counters. Vault-level git state lives in the sidebar's GitFooter, so each
 * sits next to the thing it describes.
 */
export function StatusBar(props: StatusBarProps) {
  return (
    <span class="ink-statusbar-counts">
      <span>{props.words} words</span>
      <span>{props.chars} chars</span>
    </span>
  )
}
