import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REJECT_REASON_CODES } from '../src/memory-tools.js'
import { ADMIN_L3_TEXT } from '../src/prompt.js'

test('the admin prompt matches the real memory tool contract', () => {
  assert.match(ADMIN_L3_TEXT, /memory_queue_claim/)
  assert.match(ADMIN_L3_TEXT, /memory_queue_settle/)
  assert.match(ADMIN_L3_TEXT, /memory_archive/)
  assert.match(ADMIN_L3_TEXT, /content/)
  assert.match(ADMIN_L3_TEXT, /spaceId/)
  assert.match(ADMIN_L3_TEXT, /queueId/)
  assert.match(ADMIN_L3_TEXT, /supersedesId/)
  assert.doesNotMatch(ADMIN_L3_TEXT, /memory_archive\(raw_content/, 'archive has no raw_content parameter')
  assert.doesNotMatch(ADMIN_L3_TEXT, /note:/, 'archive has no note parameter')
})

test('the admin prompt keeps the anti-injection and secret rules', () => {
  assert.match(ADMIN_L3_TEXT, /数据】的|数据】,|【数据】/)
  assert.match(ADMIN_L3_TEXT, /SUSPICIOUS_CONTENT/)
  assert.match(ADMIN_L3_TEXT, /SECRET/)
  assert.match(ADMIN_L3_TEXT, /不向用户复述/)
})

test('the admin prompt lists all five dimensions', () => {
  for (const dimension of ['fact', 'personality', 'recent', 'reflection', 'working']) {
    assert.match(ADMIN_L3_TEXT, new RegExp('^- ' + dimension + '：', 'm'))
  }
})

test('the admin prompt is static (no interpolation placeholders)', () => {
  assert.doesNotMatch(ADMIN_L3_TEXT, /\$\{/)
  assert.doesNotMatch(ADMIN_L3_TEXT, /\{\{/)
})

test('every rejection reason code is documented and the enum stays in sync', () => {
  for (const code of REJECT_REASON_CODES) {
    assert.ok(ADMIN_L3_TEXT.includes(code), `prompt documents ${code}`)
  }
  assert.match(ADMIN_L3_TEXT, /最新的那条/)
  assert.match(ADMIN_L3_TEXT, /严禁编造枚举值外的原因/)
})

test('the briefing is a single machine-readable line', () => {
  assert.match(
    ADMIN_L3_TEXT,
    /\[Summary\] archived=\{N\}, rejected=\{M\}, failed=\{K\}, details=\{简要说明\}/,
  )
  const line = '[Summary] archived=2, rejected=1, failed=0, details=归档2条偏好，拒稿1条闲聊'
  assert.match(line, /^\[Summary\] archived=\d+, rejected=\d+, failed=\d+, details=.+$/)
})

