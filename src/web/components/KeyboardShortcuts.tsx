import { shortcutDescription, shortcutLabel } from '../platform.js'

/** App commands from state/shortcuts.ts. Editor and browser commands belong to their own help. */
const groups = [
  {
    title: 'View mode',
    shortcuts: [
      ['Switch Edit / Read', 'Mod + E'],
      ['Toggle Source / Edit', 'Mod + M'],
    ],
  },
  {
    title: 'Save',
    shortcuts: [
      ['Save current note', 'Mod + S'],
      ['Save all drafts', 'Mod + Shift + S'],
    ],
  },
  {
    title: 'Workspace',
    shortcuts: [
      ['Show files', 'Mod + 1'],
      ['Show outline', 'Mod + 2'],
      ['Toggle file tree', 'Mod + \\'],
      ['Toggle history', 'Mod + /'],
    ],
  },
  {
    title: 'Notes',
    shortcuts: [
      ['New note', 'Mod + Alt + N'],
      ['New folder', 'Mod + Alt + F'],
      ["Start today’s section", 'Mod + Alt + D'],
      ['Previous visited note', 'Mod + ['],
      ['Next visited note', 'Mod + ]'],
    ],
  },
] as const

export function KeyboardShortcuts() {
  return (
    <div class="ink-shortcuts">
      <p class="ink-shortcuts-intro">
        From Source, {shortcutLabel('Mod + E')} opens Read. {shortcutLabel('Mod + M')} returns to Edit.
      </p>
      <div class="ink-settings-grid">
        {groups.map((group) => (
          <section class="ink-settings-group" key={group.title} aria-label={group.title}>
            <h3 class="ink-settings-section">{group.title}</h3>
            <dl class="ink-shortcuts-list">
              {group.shortcuts.map(([label, keys]) => (
                <div class="ink-shortcuts-row" key={label}>
                  <dt>{label}</dt>
                  <dd><kbd aria-label={shortcutDescription(keys)}>{shortcutLabel(keys)}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}
