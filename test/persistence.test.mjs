import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../src/config.js'
import { createStatsStore, dayKey, monthKey, startOfWindow } from '../src/stats-store.js'
import { createConfigStore } from '../src/config-store.js'
import { auditConfig, clampWarnings } from '../src/config-audit.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rg-store-'))
}

/** Local-time fixture: `daysAgo` 天前的 12:00（or given hour）。 */
const ANCHOR = new Date(2026, 9, 25, 18, 0, 0, 0).getTime()
function at(daysAgo, hour = 12) {
  const date = new Date(2026, 9, 25, hour, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.getTime()
}

function recordOf(ts, sessionId, overrides = {}) {
  return {
    ts,
    sessionId,
    processed: true,
    bytesBefore: 1000,
    bytesAfter: 400,
    bytesSaved: 600,
    tokensSaved: 150,
    shadowed: 2,
    hidden: 1,
    enumsKept: 3,
    itemsKept: 4,
    oversizeSlims: 1,
    ...overrides,
  }
}

// ------------------------------------------------------------------- stats

test('stats-store: aggregates by day, window and conversation', () => {
  const dir = tempDir()
  const store = createStatsStore({ dir, now: () => ANCHOR })
  store.configure(normalizeConfig({}))

  store.record(recordOf(at(0, 9), 'session-aaa'))
  store.record(recordOf(at(0, 15), 'session-aaa'))
  store.record(recordOf(at(3), 'session-bbb'))
  store.record(recordOf(at(10), 'session-ccc'))
  store.record(recordOf(at(40), 'session-old'))

  const today = store.summary('today', ANCHOR)
  assert.equal(today.assembleRequests, 2)
  assert.equal(today.assembleCalls, 2)
  assert.equal(today.bytesSaved, 1200)
  assert.equal(today.tokensBefore, 500)
  assert.equal(today.tokensAfter, 200)
  assert.equal(today.tokensSaved, 300)
  assert.equal(today.shadowed, 4)
  assert.equal(today.sessions, 1)

  const d7 = store.summary('d7', ANCHOR)
  assert.equal(d7.assembleRequests, 3)
  assert.equal(d7.sessions, 2)

  const d30 = store.summary('d30', ANCHOR)
  assert.equal(d30.assembleRequests, 4, '40 天前的记录不应进入 30 天窗口')
  assert.equal(d30.sessions, 3)

  const rows = store.conversations('d7', ANCHOR)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].sessionId, 'session-aaa')
  assert.equal(rows[0].calls, 2)
  assert.equal(rows[0].processed, 2)
  assert.equal(rows[0].tokensSaved, 300)
  assert.equal(rows[0].bytesBefore, 2000)
  assert.equal(rows[0].bytesAfter, 800)
  assert.equal(rows[0].lastAt, at(0, 15))
  assert.equal(rows[1].sessionId, 'session-bbb')

  const unprocessed = store.summary('today', ANCHOR)
  assert.equal(unprocessed.failed, 0)
})

test('stats-store: unprocessed assembles count as requests, not calls', () => {
  const dir = tempDir()
  const store = createStatsStore({ dir, now: () => ANCHOR })
  store.configure(normalizeConfig({}))
  store.record(recordOf(at(0), 'session-x', { processed: false, bytesBefore: 0, bytesAfter: 0, bytesSaved: 0, tokensSaved: 0, shadowed: 0, hidden: 0 }))

  const today = store.summary('today', ANCHOR)
  assert.equal(today.assembleRequests, 1)
  assert.equal(today.assembleCalls, 0)
})

test('stats-store: JSONL survives a restart and keeps older months', () => {
  const dir = tempDir()
  const first = createStatsStore({ dir, now: () => ANCHOR })
  first.configure(normalizeConfig({}))
  first.record(recordOf(at(0), 'session-aaa'))
  first.record(recordOf(at(3), 'session-bbb'))
  first.record(recordOf(at(40), 'session-old'))
  first.close()

  // Two monthly files: September (40 days ago) and October.
  assert.deepEqual(readdirSync(join(dir, 'stats')).sort(), ['2026-09.jsonl', '2026-10.jsonl'])
  const line = JSON.parse(readFileSync(join(dir, 'stats', '2026-10.jsonl'), 'utf8').split('\n')[0])
  assert.equal(line.v, 2)
  assert.equal(line.sessionId, undefined)
  assert.equal(line.sid, 'session-aaa')
  assert.equal(line.processed, 1)
  assert.equal(line.tokensBefore, 250)
  assert.equal(line.tokensAfter, 100)
  assert.equal(line.tokensSaved, 150)

  const second = createStatsStore({ dir, now: () => ANCHOR })
  second.configure(normalizeConfig({}))
  const info = second.info()
  assert.equal(info.recordsLoaded, 3)
  assert.equal(info.corruptLines, 0)
  assert.deepEqual(info.months, ['2026-09', '2026-10'])
  assert.equal(second.summary('d30', ANCHOR).assembleRequests, 2)
  assert.equal(second.summary('today', ANCHOR).assembleRequests, 1)
  assert.equal(second.conversations('d30', ANCHOR).length, 2)
  second.close()
})

test('stats-store: a 30-day window crossing two month boundaries reads all months', () => {
  const dir = tempDir()
  // 3 月 1 日往前 30 天落在 1 月 31 日：要同时读到 1 月、2 月、3 月三个文件。
  const now = new Date(2026, 2, 1, 12, 0, 0, 0).getTime()
  const first = createStatsStore({ dir, now: () => now })
  first.configure(normalizeConfig({}))
  first.record(recordOf(new Date(2026, 0, 31, 12).getTime(), 'session-jan'))
  first.record(recordOf(new Date(2026, 1, 15, 12).getTime(), 'session-feb'))
  first.record(recordOf(now, 'session-mar'))
  first.close()

  assert.deepEqual(readdirSync(join(dir, 'stats')).sort(), ['2026-01.jsonl', '2026-02.jsonl', '2026-03.jsonl'])
  const second = createStatsStore({ dir, now: () => now })
  second.configure(normalizeConfig({}))
  assert.equal(second.info().recordsLoaded, 3)
  assert.equal(second.summary('d30', now).assembleRequests, 3)
  assert.equal(second.summary('d7', now).assembleRequests, 1)
  second.close()
})

test('stats-store: corrupt lines are skipped and disabled mode writes nothing', () => {
  const dir = tempDir()
  const first = createStatsStore({ dir, now: () => ANCHOR })
  first.configure(normalizeConfig({}))
  first.record(recordOf(at(0), 'session-aaa'))
  first.close()

  writeFileSync(join(dir, 'stats', '2026-10.jsonl'), `${readFileSync(join(dir, 'stats', '2026-10.jsonl'), 'utf8')}not json\n{"ts":1}\n`, 'utf8')

  const second = createStatsStore({ dir, now: () => ANCHOR })
  second.configure(normalizeConfig({}))
  assert.equal(second.info().recordsLoaded, 1)
  assert.equal(second.info().corruptLines, 2)
  assert.equal(second.summary('today', ANCHOR).assembleRequests, 1)
  second.close()

  const quietDir = tempDir()
  const quiet = createStatsStore({ dir: quietDir, now: () => ANCHOR })
  quiet.configure(normalizeConfig({ storage: { enabled: false } }))
  quiet.record(recordOf(at(0), 'session-quiet'))
  assert.equal(quiet.summary('today', ANCHOR).assembleRequests, 1)
  assert.equal(existsSync(join(quietDir, 'stats')), false)
  assert.equal(quiet.info().enabled, false)
})

test('stats-store: timezone and day helpers use the local calendar', () => {
  assert.equal(typeof Intl.DateTimeFormat().resolvedOptions().timeZone, 'string')
  assert.equal(dayKey(new Date(2026, 9, 5, 23, 59).getTime()), '2026-10-05')
  assert.equal(monthKey(new Date(2026, 9, 5).getTime()), '2026-10')
  const start = startOfWindow(new Date(2026, 9, 25, 18).getTime(), 7)
  assert.equal(start.getDate(), 19)
  assert.equal(start.getHours(), 0)
})

// ------------------------------------------------------------------ config

test('config-store: save, reload, backup and restore', () => {
  const dir = tempDir()
  const baseConfig = normalizeConfig({ truncation: { maxDescriptionChars: 260 } })
  const store = createConfigStore({ dir, baseConfig, now: () => ANCHOR })

  assert.equal(store.status().source, 'profile')
  assert.equal(store.effective().truncation.maxDescriptionChars, 260)

  const saved = store.save({ truncation: { maxDescriptionChars: 300 } }, { source: 'tuning', note: '试一下' })
  assert.equal(saved.config.truncation.maxDescriptionChars, 300)
  assert.match(saved.backupId, /^\d{8}-\d{6}-[a-f0-9]{4}$/)
  assert.deepEqual(saved.changed, ['truncation.maxDescriptionChars'])
  assert.equal(saved.error, null)
  assert.equal(existsSync(join(dir, 'config.json')), true)
  assert.equal(store.status().source, 'store')
  assert.equal(store.status().origin, 'tuning')

  const reloaded = createConfigStore({ dir, baseConfig, now: () => ANCHOR })
  assert.equal(reloaded.effective().truncation.maxDescriptionChars, 300)
  assert.equal(reloaded.storedConfig().truncation.maxDescriptionChars, 300)
  assert.equal(reloaded.status().source, 'store')

  const backups = reloaded.listBackups()
  assert.equal(backups.length, 1)
  assert.equal(backups[0].id, saved.backupId)
  assert.equal(backups[0].source, 'before-save')
  assert.equal(backups[0].note, '试一下')

  const restored = reloaded.restoreBackup(saved.backupId)
  assert.equal(restored.config.truncation.maxDescriptionChars, 260)
  assert.equal(restored.error, null)
  assert.match(restored.backupId, /^\d{8}-\d{6}-[a-f0-9]{4}$/)
  assert.equal(reloaded.effective().truncation.maxDescriptionChars, 260)

  const reset = reloaded.resetDefaults()
  assert.equal(reset.config.truncation.maxDescriptionChars, 260)
  assert.equal(reloaded.storedConfig(), null)
  assert.equal(reloaded.status().source, 'profile')
  assert.equal(reloaded.listBackups().length, 3)
})

test('config-store: error semantics for bad archives and ids', () => {
  const dir = tempDir()
  const baseConfig = normalizeConfig({})
  writeFileSync(join(dir, 'config.json'), '{ not json', 'utf8')
  const store = createConfigStore({ dir, baseConfig, now: () => ANCHOR })
  assert.equal(store.storedConfig(), null)
  assert.equal(store.status().source, 'profile')
  assert.equal(typeof store.status().error, 'string')

  assert.equal(store.restoreBackup('../config').error, 'invalid backup id')
  assert.equal(store.restoreBackup('20260101-000000-zzzz').error, 'invalid backup id')
})

test('config-store: maxBackups prunes old snapshots', () => {
  const dir = tempDir()
  const store = createConfigStore({ dir, baseConfig: normalizeConfig({}), now: () => ANCHOR })
  store.save({ storage: { maxBackups: 2 } })
  store.save({ truncation: { maxDepth: 2 } })
  store.save({ truncation: { maxDepth: 3 } })
  store.save({ truncation: { maxDepth: 4 } })
  assert.equal(store.listBackups().length, 2)
})

test('config-store: prototype keys are ignored when merging', () => {
  const store = createConfigStore({ dir: tempDir(), baseConfig: normalizeConfig({}), now: () => ANCHOR })
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"truncation":{"maxDepth":3}}')
  store.save(hostile)
  assert.equal({}.polluted, undefined)
  assert.equal(store.effective().truncation.maxDepth, 3)
})

// ------------------------------------------------------------------- audit

test('config-audit: flags dangerous combinations and normalized values', () => {
  const risky = normalizeConfig({ truncation: { shadowPrefixes: [] }, visibility: { enabled: true }, freeze: { enabled: false } })
  const warnings = auditConfig(risky)
  assert.equal(warnings.some((warning) => warning.includes('全部工具')), true)
  assert.equal(warnings.some((warning) => warning.includes('名单为空')), true)
  assert.equal(warnings.some((warning) => warning.includes('会话冻结')), true)

  const effective = normalizeConfig({ truncation: { maxDepth: 99 } })
  const clamps = clampWarnings({ truncation: { maxDepth: 99 }, unknownTop: { a: 1 } }, effective)
  assert.equal(clamps.some((warning) => warning.includes('truncation.maxDepth') && warning.includes('6')), true)
  assert.equal(clamps.some((warning) => warning.includes('unknownTop.a')), true)
})
