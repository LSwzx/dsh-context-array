import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBootstrapMessage, deliverBootstrap } from '../src/append.js'

const SECTIONS = [
  { name: 'space', text: 'space-default (Default space)' },
  { name: 'rules', text: 'Shared workspace facts stay in this space.' },
]

test('buildBootstrapMessage shapes one user message with a bootstrap block', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })

  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.notEqual(message.id, buildBootstrapMessage({ sections: SECTIONS }).id)

  assert.equal(message.source.kind, 'context-array')
  assert.equal(message.source.form, 'snapshot')
  assert.deepEqual(message.source.sections, SECTIONS)

  assert.equal(message.content.length, 1)
  const [block] = message.content
  assert.equal(block.type, 'text')
  assert.ok(block.text.startsWith('<context-array-bootstrap>\n'))
  assert.ok(block.text.endsWith('\n</context-array-bootstrap>'))
  assert.ok(block.text.includes('## space\nspace-default (Default space)'))
  assert.ok(block.text.includes('## rules\nShared workspace facts stay in this space.'))
  assert.ok(block.text.indexOf('## space') < block.text.indexOf('## rules'))
})

test('buildBootstrapMessage tolerates missing or malformed sections', () => {
  for (const input of [undefined, {}, { sections: null }, { sections: [] }, { sections: 'nope' }]) {
    const message = buildBootstrapMessage(input)
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source.sections, [])
    assert.deepEqual(message.content, [{ type: 'text', text: '<context-array-bootstrap>\n</context-array-bootstrap>' }])
  }

  const [section] = buildBootstrapMessage({ sections: [{ name: 42, text: null }, null] }).source.sections
  assert.deepEqual(section, { name: '', text: '' })
})

test('deliverBootstrap injects the message once and reports acceptance', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })
  const injected = []
  const agent = {
    inject(candidate) {
      injected.push(candidate)
    },
  }

  assert.equal(deliverBootstrap(agent, message), true)
  assert.equal(injected.length, 1)
  assert.equal(injected[0], message)
})

test('deliverBootstrap returns false when agent.inject throws and reports the error', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })
  const failure = new Error('inject rejected the message')
  const errors = []
  const agent = {
    inject() {
      throw failure
    },
  }

  let accepted
  assert.doesNotThrow(() => {
    accepted = deliverBootstrap(agent, message, { onError: error => errors.push(error) })
  })
  assert.equal(accepted, false)
  assert.deepEqual(errors, [failure])
})

test('deliverBootstrap never throws when onError is omitted or itself throws', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })
  const throwingAgent = {
    inject() {
      throw new Error('nope')
    },
  }

  assert.doesNotThrow(() => assert.equal(deliverBootstrap(throwingAgent, message), false))
  assert.doesNotThrow(() => {
    assert.equal(
      deliverBootstrap(throwingAgent, message, {
        onError: () => {
          throw new Error('error sink exploded')
        },
      }),
      false,
    )
  })
})

test('deliverBootstrap treats an explicit false return as a rejection', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })

  assert.equal(deliverBootstrap({ inject: () => false }, message), false)
  assert.equal(deliverBootstrap({ inject: () => true }, message), true)
  assert.equal(deliverBootstrap({ inject: () => undefined }, message), true)
})

test('deliverBootstrap returns false for an agent without inject()', () => {
  const message = buildBootstrapMessage({ sections: SECTIONS })
  const errors = []

  assert.equal(deliverBootstrap(undefined, message, { onError: error => errors.push(error) }), false)
  assert.equal(deliverBootstrap({}, message, { onError: error => errors.push(error) }), false)
  assert.equal(errors.length, 2)
  assert.ok(errors.every(error => error instanceof TypeError))
})
