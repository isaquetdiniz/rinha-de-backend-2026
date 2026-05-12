import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { parseReferences } from './parse-refs.ts'

const FIXTURE_PATH = '/tmp/test-refs.json.gz'

const fixture = [
  { vector: [0.1, 0.2, 0.3, 0.4, 0.5, -1, -1, 0.1, 0.2, 0, 1, 0, 0.3, 0.4], label: 'legit' },
  { vector: [0.9, 0.8, 1.0, 0.2, 0.8, -1, -1, 0.9, 1.0, 0, 1, 1, 0.7, 0.5], label: 'fraud' },
  { vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.3, 0.1, 0.5, 0.5, 1, 0, 0, 0.5, 0.5], label: 'legit' },
]

before(() => {
  writeFileSync(FIXTURE_PATH, gzipSync(JSON.stringify(fixture)))
})

after(() => {
  unlinkSync(FIXTURE_PATH)
})

describe('parseReferences', () => {
  it('emite todos os registros na ordem correta', async () => {
    const records = []
    for await (const rec of parseReferences(FIXTURE_PATH)) {
      records.push(rec)
    }
    assert.equal(records.length, 3)
    assert.equal(records[0]!.label, 'legit')
    assert.equal(records[1]!.label, 'fraud')
    assert.equal(records[2]!.label, 'legit')
    assert.equal(records[0]!.vector.length, 14)
  })

  it('preserva valores -1 nas dimensões 5 e 6', async () => {
    const records = []
    for await (const rec of parseReferences(FIXTURE_PATH)) {
      records.push(rec)
    }
    assert.equal(records[0]!.vector[5], -1)
    assert.equal(records[0]!.vector[6], -1)
  })
})
