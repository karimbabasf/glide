// Loopback end-to-end probe. Spawns the real agent, then plays the phone side
// on this same machine, going through the real production signaling. Instruments
// the phone -> signaling -> agent boundary so we can see WHERE a pairing breaks.
//
// PASS means: code path and signaling both work when instances are warm and the
// two peers share a machine. A real-phone failure after a PASS here is network or
// store-timing, not code.

import { RTCPeerConnection } from 'node-datachannel/polyfill'
import nodeDataChannel from 'node-datachannel'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = HERE
const SIGNAL = (process.env.PM_SIGNAL_URL || 'https://phone-mouse-psi.vercel.app').replace(/\/+$/, '')
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const post = async (body) => {
  const r = await fetch(`${SIGNAL}/api/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}
const iceComplete = (pc) =>
  pc.iceGatheringState === 'complete'
    ? Promise.resolve()
    : new Promise((res) => {
        const t = setTimeout(res, 4000)
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            clearTimeout(t)
            res()
          }
        }
      })

const flags = { answerRecv: false, linkUp: false, paired: false }
let agent

function cleanup(code) {
  try {
    agent?.kill('SIGINT')
  } catch {}
  setTimeout(() => {
    try {
      nodeDataChannel.cleanup()
    } catch {}
    process.exit(code)
  }, 400)
}

try {
  agent = spawn('node', ['index.js'], {
    cwd: AGENT_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PM_SIGNAL_URL: SIGNAL },
  })
  const rl = readline.createInterface({ input: agent.stdout })

  const parsed = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('agent printed no pairing URL in 15s')), 15000)
    rl.on('line', (raw) => {
      const line = strip(raw)
      if (line.trim()) console.log('  [agent]', line)
      if (/answer received/.test(line)) flags.answerRecv = true
      if (/direct peer link up/.test(line)) flags.linkUp = true
      if (/\bpaired\b/.test(line)) flags.paired = true
      const m = line.match(/#r=([a-f0-9]+)&s=([a-f0-9]+)/)
      if (m) {
        clearTimeout(t)
        resolve({ room: m[1], secret: m[2] })
      }
    })
  })

  const { room, secret } = parsed
  const secretHash = createHash('sha256').update(secret).digest('hex')

  console.log(`\n  [phone] fetch offer, room ${room}`)
  const fetched = await post({ op: 'fetch', room, secretHash })
  if (!fetched.offer) throw new Error('fetch failed: ' + JSON.stringify(fetched))

  const pc = new RTCPeerConnection({ iceServers: ICE })
  const chans = {}
  const settled = new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('phone saw no auth ok / channels never opened (20s)')),
      20000,
    )
    pc.oniceconnectionstatechange = () => console.log('  [phone] ice:', pc.iceConnectionState)
    pc.ondatachannel = (e) => {
      const dc = e.channel
      chans[dc.label] = dc
      console.log('  [phone] datachannel opened:', dc.label)
      if (dc.label === 'ctrl') {
        dc.onopen = () => {
          console.log('  [phone] ctrl open, sending auth')
          dc.send(JSON.stringify({ t: 'auth', secret }))
        }
        dc.onmessage = (ev) => {
          const msg = JSON.parse(ev.data)
          console.log('  [phone] recv:', JSON.stringify(msg))
          if (msg.t === 'ok') dc.send(JSON.stringify({ t: 'ping', id: 1 }))
          if (msg.t === 'pong') {
            clearTimeout(t)
            resolve()
          }
          if (msg.t === 'deny') {
            clearTimeout(t)
            reject(new Error('agent denied the secret'))
          }
        }
      }
    }
  })

  await pc.setRemoteDescription({ type: 'offer', sdp: fetched.offer })
  await pc.setLocalDescription(await pc.createAnswer())
  await iceComplete(pc)
  const ans = await post({ op: 'answer', room, secretHash, answer: pc.localDescription.sdp })
  console.log('  [phone] answer posted:', JSON.stringify(ans))

  await settled

  if (chans.input?.readyState === 'open') {
    chans.input.send(JSON.stringify({ t: 'm', dx: 5, dy: 5 }))
    console.log('  [phone] sent a move over the input channel')
  }

  console.log('\n  RESULT: PASS')
  console.log('  both channels open:', Boolean(chans.ctrl && chans.input))
  console.log('  agent flags:', JSON.stringify(flags))
  pc.close()
  cleanup(0)
} catch (e) {
  console.log(`\n  RESULT: FAIL (${e.message})`)
  console.log('  agent flags:', JSON.stringify(flags))
  console.log('  reading: answerRecv=false means the agent never got the phone answer (store race).')
  console.log('           answerRecv=true and linkUp=false means ICE could not connect (network).')
  cleanup(1)
}
