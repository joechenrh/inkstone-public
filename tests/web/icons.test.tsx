import { render } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { IconCommit, IconEditMode, IconFiles, IconFolder, IconGitBranch, IconOutline, IconReadMode, IconRightPanel, IconSettings, IconSidebar, IconTrash, IconUnsavedDot } from '../../src/web/components/icons.js'

describe('icons', () => {
  it('renders an svg with a currentColor stroke', () => {
    const { container } = render(<IconSettings />)
    const svg = container.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })
  it('the gear has the ink-icon-gear class (used for hover rotation)', () => {
    const { container } = render(<IconSettings />)
    expect(container.querySelector('svg')?.getAttribute('class') ?? '').toContain('ink-icon')
  })
  it('the unsaved dot is a small filled circle', () => {
    const { container } = render(<IconUnsavedDot />)
    expect(container.querySelector('circle')).toBeTruthy()
  })
  it('passes through class', () => {
    const { container } = render(<IconTrash class="foo" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('foo')
  })

  // Strengthened assertions
  it('IconSettings svg class includes ink-icon-gear', () => {
    const { container } = render(<IconSettings />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('ink-icon-gear')
  })

  it('non-gear icon IconTrash does not have the ink-icon-gear class', () => {
    const { container } = render(<IconTrash />)
    const svg = container.querySelector('svg')!
    const cls = svg.getAttribute('class') ?? ''
    expect(cls).not.toContain('ink-icon-gear')
  })

  it('with a title prop, the svg has role=img and a <title> element', () => {
    const { container } = render(<IconSettings title="Settings" />)
    const svg = container.querySelector('svg')!
    const title = container.querySelector('title')!
    expect(svg.getAttribute('role')).toBe('img')
    expect(title).toBeTruthy()
    expect(title.textContent).toBe('Settings')
  })

  it('without a title prop, the svg has aria-hidden=true and no role=img', () => {
    const { container } = render(<IconSettings />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
    expect(container.querySelector('title')).toBeNull()
  })

  it('IconUnsavedDot circle has fill=currentColor', () => {
    const { container } = render(<IconUnsavedDot />)
    const circle = container.querySelector('circle')!
    expect(circle).toBeTruthy()
    expect(circle.getAttribute('fill')).toBe('currentColor')
  })

  it('IconCommit renders an svg with a currentColor stroke', () => {
    const { container } = render(<IconCommit />)
    const svg = container.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('fill')).toBe('none')
  })

  it('IconCommit contains circle and line elements', () => {
    const { container } = render(<IconCommit />)
    expect(container.querySelector('circle')).toBeTruthy()
    expect(container.querySelector('line')).toBeTruthy()
  })

  it('IconCommit has the ink-icon class', () => {
    const { container } = render(<IconCommit />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('ink-icon')
  })

  it('IconGitBranch renders an svg with a currentColor stroke', () => {
    const { container } = render(<IconGitBranch />)
    const svg = container.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('fill')).toBe('none')
  })

  it('IconGitBranch contains circle and path elements', () => {
    const { container } = render(<IconGitBranch />)
    expect(container.querySelector('circle')).toBeTruthy()
    expect(container.querySelector('path')).toBeTruthy()
  })

  it('IconGitBranch has the ink-icon class', () => {
    const { container } = render(<IconGitBranch />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('ink-icon')
  })
})

describe('sidebar switcher icons', () => {
  it('IconFiles renders an svg stroked with currentColor', () => {
    const { container } = render(<IconFiles />)
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor')
  })

  it('IconOutline renders an svg stroked with currentColor', () => {
    const { container } = render(<IconOutline />)
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor')
  })

  it('both accept a title for the accessible name', () => {
    const { container } = render(<IconOutline title="Outline" />)
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Outline')
  })

  // The switcher's files glyph and the new-folder action must not be the same shape:
  // they sit next to each other in the sidebar header and would be mis-clicked.
  it('IconFiles is not the same shape as IconFolder', () => {
    const files = render(<IconFiles />).container.querySelector('svg')?.innerHTML
    const folder = render(<IconFolder />).container.querySelector('svg')?.innerHTML
    expect(files).not.toBe(folder)
  })
})

// The hover motion is CSS-driven off these hooks; without them it silently stops working.
describe('switcher icon animation hooks', () => {
  it('IconFiles carries its class and names both sheets', () => {
    const { container } = render(<IconFiles />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('ink-icon-files')
    expect(svg.querySelector('.ink-files-front')).toBeTruthy()
    expect(svg.querySelector('.ink-files-back')).toBeTruthy()
  })

  it('IconOutline carries its class and names each bar for the stagger', () => {
    const { container } = render(<IconOutline />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toContain('ink-icon-outline')
    for (const bar of ['.ink-outline-b1', '.ink-outline-b2', '.ink-outline-b3']) {
      expect(svg.querySelector(bar)).toBeTruthy()
    }
  })

  // The hover motion lives in icons.css and hangs entirely off these class names: each icon moves
  // the part of itself that means something, so a renamed hook silently stops the animation with
  // nothing else breaking.
  describe('hover-motion hooks', () => {
    const cls = (el: Element | null | undefined) => el?.getAttribute('class') ?? ''

    it('the panel toggles mark which side they belong to, and their moving edge', () => {
      const left = render(<IconSidebar />).container
      const right = render(<IconRightPanel />).container
      expect(cls(left.querySelector('svg'))).toContain('ink-icon-panel--left')
      expect(cls(right.querySelector('svg'))).toContain('ink-icon-panel--right')
      for (const c of [left, right]) {
        expect(c.querySelector('line.ink-panel-edge')).toBeTruthy()
      }
    })

    it('the nib moves as a whole, so the hook is on the svg', () => {
      expect(cls(render(<IconEditMode />).container.querySelector('svg'))).toContain('ink-icon-nib')
    })

    it('the page moves only its last line, so that line carries its own hook', () => {
      const { container } = render(<IconReadMode />)
      expect(cls(container.querySelector('svg'))).toContain('ink-icon-page')
      const tail = container.querySelector('line.ink-page-tail')
      expect(tail).toBeTruthy()
      // It is the short one — the animation extends it to the full measure.
      expect(Number(tail!.getAttribute('x2'))).toBeLessThan(15.5)
    })
  })
})
