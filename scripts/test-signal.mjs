// Exercises the signaling handshake, including the paths that must be refused.
// Runs against production by default.

import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.env.PM_SIGNAL_URL || 'https://phone-mouse-psi.vercel.app').replace(/\/+$/, '')
const API = `${BASE}/api/signal`

const room = randomBytes(8).toString('hex')
const secret = randomBytes(16).toString('hex')
const hash = createHash('sha256').update(secret).digest('hex')
const wrong = '0'.repeat(64)

let failures = 0

async function check(label, body, expectStatus, expect = () => true) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  const ok = res.status === expectStatus && expect(json)
  if (!ok) failures++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(26)} [${res.status}] ${JSON.stringify(json).slice(0, 80)}`)
}

console.log(`signaling: ${API}`)
console.log(`room: ${room}\n`)

await check('publish offer', { op: 'publish', room, secretHash: hash, offer: 'v=0 TEST' }, 200, (j) => j.ok)
await check('fetch, wrong secret', { op: 'fetch', room, secretHash: wrong }, 403)
await check('fetch, right secret', { op: 'fetch', room, secretHash: hash }, 200, (j) => j.offer === 'v=0 TEST')
await check('poll before answer', { op: 'poll', room, secretHash: hash }, 200, (j) => j.pending === true)
await check('answer, wrong secret', { op: 'answer', room, secretHash: wrong, answer: 'v=0 X' }, 403)
await check('answer, right secret', { op: 'answer', room, secretHash: hash, answer: 'v=0 ANS' }, 200, (j) => j.ok)
await check('poll collects answer', { op: 'poll', room, secretHash: hash }, 200, (j) => j.answer === 'v=0 ANS')
await check('poll again is one-shot', { op: 'poll', room, secretHash: hash }, 404)
await check('unknown room', { op: 'fetch', room: 'deadbeefdeadbeef', secretHash: hash }, 404)
await check('malformed room', { op: 'fetch', room: '!!', secretHash: hash }, 400)
await check('unknown op', { op: 'nope', room, secretHash: hash }, 400)

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
