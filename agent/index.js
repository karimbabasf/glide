// Local agent. Holds one side of a WebRTC peer connection with the phone and
// pipes the input stream into the Swift CGEvent injector.
//
// Nothing here listens on a port. The agent dials out to the signaling endpoint,
// swaps SDP, and from then on talks to the phone directly.

import { RTCPeerConnection } from 'node-datachannel/polyfill'
import nodeDataChannel from 'node-datachannel'
import { spawn } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import qrcode from 'qrcode-terminal'

const DEFAULT_SIGNAL = 'https://phone-mouse-psi.vercel.app'
const SIGNAL = (process.env.PM_SIGNAL_URL || DEFAULT_SIGNAL).replace(/\/+$/, '')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INJECTOR = path.join(HERE, 'injector')

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Only these ever reach the injector, regardless of what arrives on the wire.
const ALLOWED = new Set(['m', 'd', 'u', 'c', 's', 'txt', 'key', 'bounds'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('  ', ...a)

// ------------------------------------------------------------------ injector

if (!existsSync(INJECTOR)) {
  console.error('\n  injector binary missing. Build it first:\n')
  console.error('    swiftc -O -parse-as-library injector.swift -o injector\n')
  process.exit(1)
}

const injector = spawn(INJECTOR, [], { stdio: ['pipe', 'pipe', 'inherit'] })
let screen = ''

readline.createInterface({ input: injector.stdout }).on('line', (line) => {
  if (line.startsWith('ready ')) {
    screen = line.slice(6).trim()
    log(`injector ready, desktop ${screen}`)
  }
})

injector.on('exit', (code) => {
  console.error(`\n  injector exited (${code}). Stopping.\n`)
  process.exit(1)
})

function toInjector(msg) {
  if (!msg || typeof msg.t !== 'string' || !ALLOWED.has(msg.t)) return
  injector.stdin.write(JSON.stringify(msg) + '\n')
}

// ------------------------------------------------------------------ signaling

async function post(body) {
  const res = await fetch(`${SIGNAL}/api/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))
}

function iceComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(resolve, 4000)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate) done()
    }
  })
}

// ------------------------------------------------------------------ session

async function session() {
  const room = randomBytes(8).toString('hex')
  const secret = randomBytes(16).toString('hex') // 128 bits
  const secretHash = createHash('sha256').update(secret).digest('hex')

  const pc = new RTCPeerConnection({ iceServers: ICE })

  // Reliable and ordered: auth, clicks, keys, telemetry. Correctness matters,
  // volume is tiny.
  const ctrl = pc.createDataChannel('ctrl', { ordered: true })
  // Unreliable and unordered: movement and scroll. A lost packet is superseded
  // by the next one a frame later, and retransmits would stall everything
  // behind them (head-of-line blocking is what makes these apps feel laggy).
  const input = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 })

  let authed = false
  let closed = false

  const expected = Buffer.from(secret, 'utf8')
  const verify = (given) => {
    const got = Buffer.from(String(given ?? ''), 'utf8')
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  ctrl.onmessage = (ev) => {
    let m
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }

    if (m.t === 'auth') {
      if (verify(m.secret)) {
        authed = true
        ctrl.send(JSON.stringify({ t: 'ok', screen }))
        log('\x1b[32mpaired\x1b[0m, phone is driving the cursor')
      } else {
        ctrl.send(JSON.stringify({ t: 'deny' }))
        log('\x1b[31mrejected\x1b[0m a peer with a bad secret')
        setTimeout(() => pc.close(), 250)
      }
      return
    }

    if (!authed) return
    if (m.t === 'ping') {
      ctrl.send(JSON.stringify({ t: 'pong', id: m.id }))
      return
    }
    toInjector(m)
  }

  input.onmessage = (ev) => {
    if (!authed) return
    try {
      toInjector(JSON.parse(ev.data))
    } catch {
      /* ignore malformed frames */
    }
  }

  await pc.setLocalDescription(await pc.createOffer())
  await iceComplete(pc)

  const published = await post({
    op: 'publish',
    room,
    secretHash,
    offer: pc.localDescription.sdp,
  })
  if (!published.ok) {
    console.error(`\n  signaling server rejected the offer: ${published.error}`)
    console.error(`  endpoint: ${SIGNAL}/api/signal\n`)
    pc.close()
    return 'retry'
  }
  if (published.store === 'memory') {
    log('\x1b[33mnote\x1b[0m signaling store is instance memory, see README if pairing fails')
  }

  const url = `${SIGNAL}/#r=${room}&s=${secret}`
  console.log('\n  Scan this with your phone:\n')
  qrcode.generate(url, { small: true })
  console.log(`  or open: ${url}\n`)
  log('code expires in 3 minutes')

  // Wait for the phone's answer.
  const deadline = Date.now() + 175_000
  for (;;) {
    if (Date.now() > deadline) {
      log('code expired, generating a new one')
      pc.close()
      return 'retry'
    }
    await sleep(1000)
    const res = await post({ op: 'poll', room, secretHash })
    if (res.answer) {
      await pc.setRemoteDescription({ type: 'answer', sdp: res.answer })
      log('answer received, opening direct link')
      break
    }
    if (!res.ok && res.error === 'expired') {
      log('pairing record expired, generating a new one')
      pc.close()
      return 'retry'
    }
  }

  // Hold the session until the peer goes away.
  await new Promise((resolve) => {
    const finish = (why) => {
      if (closed) return
      closed = true
      log(`link closed (${why})`)
      try {
        pc.close()
      } catch {
        /* already gone */
      }
      resolve()
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if (s === 'connected') log('\x1b[32mdirect peer link up\x1b[0m')
      if (s === 'failed' || s === 'closed' || s === 'disconnected') finish(s)
    }
    ctrl.onclose = () => finish('channel closed')
  })

  return 'retry'
}

// ------------------------------------------------------------------ main

console.log('\n  \x1b[1mphone mouse agent\x1b[0m')
log(`signaling via ${SIGNAL}`)

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true
    console.log('\n  shutting down')
    try {
      injector.stdin.end()
      injector.kill()
    } catch {
      /* already gone */
    }
    try {
      nodeDataChannel.cleanup()
    } catch {
      /* already gone */
    }
    process.exit(0)
  })
}

while (!stopping) {
  try {
    await session()
  } catch (e) {
    console.error(`\n  session error: ${e?.message ?? e}`)
    await sleep(2000)
  }
}
