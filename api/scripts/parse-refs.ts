import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createRequire } from 'node:module'

interface ReferenceRecord {
  vector: number[]
  label: 'fraud' | 'legit'
}

const require = createRequire(import.meta.url)
const Chain = require('stream-chain') as {
  new (fns: unknown[]): AsyncIterable<{ key: number; value: unknown }>
}
const makeParser = require('stream-json') as (opts?: unknown) => NodeJS.ReadWriteStream
const StreamArray = require('stream-json/streamers/StreamArray') as {
  new (): NodeJS.ReadWriteStream
  withParser: () => NodeJS.ReadWriteStream & AsyncIterable<{ key: number; value: unknown }>
}

export async function* parseReferences(filePath: string): AsyncGenerator<ReferenceRecord> {
  const pipeline = new Chain([
    createReadStream(filePath),
    createGunzip(),
    makeParser(),
    new StreamArray(),
  ]) as AsyncIterable<{ key: number; value: unknown }>

  for await (const { value } of pipeline) {
    yield value as ReferenceRecord
  }
}
