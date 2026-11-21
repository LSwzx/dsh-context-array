/**
 * L5 append layer for the M1 bootstrap snapshot.
 *
 * A bootstrap snapshot is queued with `agent.inject()`: it lands after
 * `step/start`, never touches the L1–L4 prefix, and does not wake the agent
 * (CONTRACT.md, v4.1 §2 rule 2).
 *
 * @module dsh-context-array/append
 */
import crypto from 'node:crypto'

const SOURCE_KIND = 'context-array'
const SOURCE_FORM = 'snapshot'
const OPEN_TAG = '<context-array-bootstrap>'
const CLOSE_TAG = '</context-array-bootstrap>'

/** Copy `[{ name, text }]` into plain, string-only section objects. */
function normalizeSections(sections) {
  if (!Array.isArray(sections)) return []
  return sections.map(section => ({
    name: isObject(section) && typeof section.name === 'string' ? section.name : '',
    text: isObject(section) && typeof section.text === 'string' ? section.text : '',
  }))
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Render the sections as one append-only text block. */
function renderBootstrapText(sections) {
  const body = sections
    .map(({ name, text }) => {
      const heading = name.length > 0 ? `## ${name}` : '##'
      return text.length > 0 ? `${heading}\n${text}` : heading
    })
    .join('\n\n')
  return body.length > 0 ? `${OPEN_TAG}\n${body}\n${CLOSE_TAG}` : `${OPEN_TAG}\n${CLOSE_TAG}`
}

/**
 * Build the snapshot message appended at the start of a session.
 * @param {{ sections?: Array<{ name: string, text: string }> }} [input]
 * @returns {object} user message with a `context-array` snapshot source
 */
export function buildBootstrapMessage({ sections } = {}) {
  const normalized = normalizeSections(sections)
  return {
    role: 'user',
    id: crypto.randomUUID(),
    source: { kind: SOURCE_KIND, form: SOURCE_FORM, sections: normalized },
    content: [{ type: 'text', text: renderBootstrapText(normalized) }],
  }
}

/**
 * Queue the bootstrap message for the next `agent/pre-step`.
 * Never throws: a failed bootstrap must not break the turn.
 * @param {{ inject?: (message: object) => unknown }} agent
 * @param {object} message from `buildBootstrapMessage`
 * @param {{ onError?: (error: unknown) => void }} [options]
 * @returns {boolean} true when accepted, false when the runtime rejected it
 */
export function deliverBootstrap(agent, message, { onError } = {}) {
  try {
    if (!isObject(agent) || typeof agent.inject !== 'function') {
      throw new TypeError('deliverBootstrap requires an agent with an inject() method')
    }
    // A void return means accepted; only an explicit false is a rejection.
    return agent.inject(message) !== false
  } catch (error) {
    try {
      if (typeof onError === 'function') onError(error)
    } catch {
      // An error sink that throws must not break the turn either.
    }
    return false
  }
}
