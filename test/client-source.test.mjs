/**
 * Client bundle guards that need no browser.
 *
 * The queue tab blanked the whole panel because `StatusGlyph` was declared as a
 * positional function but used as `h(StatusGlyph, { status })`: React passes a props
 * object, which then reached a text child and threw "Objects are not valid as a React
 * child". These source-level checks keep that class of mistake from coming back.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')

test('the client bundle parses', () => {
  assert.doesNotThrow(() => new Function(source))
})

test('every component passed to h(name, props) takes a props object, not a positional value', () => {
  // Names used as element types with a props object: h(Name, { … }).
  const used = new Set()
  for (const match of source.matchAll(/\bh\(([A-Z]\w*),\s*\{/g)) used.add(match[1])
  for (const name of used) {
    const definition = source.match(new RegExp(`function ${name}\\s*\\(([^)]*)\\)`))
    if (!definition) continue
    const parameter = definition[1].trim()
    const takesProps = parameter === '' || parameter.startsWith('props') || parameter.startsWith('{')
    assert.ok(
      takesProps,
      `component ${name} is called as h(${name}, { … }) but declares a positional parameter "${parameter}"`,
    )
  }
})

test('the queue status pill has a label fallback for unknown statuses', () => {
  assert.match(source, /function StatusGlyph\(\{ status \}\)/)
  assert.match(source, /STATUS_META\[status\] \|\| \{ glyph: '\?', label: String\(status \?\? ''\) \}/)
})

test('tab content is wrapped in an error boundary', () => {
  assert.match(source, /class TabBoundary extends React\.Component/)
  assert.match(source, /h\(\s*TabBoundary,/)
})
