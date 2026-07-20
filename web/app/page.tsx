'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'fetching' | 'negotiating' | 'waiting' | 'live' | 'error'

const ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Pointer acceleration. Near 1:1 when the finger is slow (precision work),
// saturating toward MAX_GAIN on a flick (cross the screen in one swipe).
// Exponential saturation keeps it continuous, so there is no gear-change feel.
const MIN_GAIN = 0.85
const MAX_GAIN = 3.2
const KNEE = 1.6 // px per ms at which the curve is meaningfully engaged

const TAP_MS = 220
const TAP_SLOP = 12 // px of travel still counted as a tap
const DOUBLE_MS = 260
const LONG_PRESS_MS = 480
const TRACE_MS = 620
const SCROLL_GAIN = 1.15
const CLASSIFY_SLOP = 14 // total two-finger travel before committing to scroll vs drag
const STATIONARY_SLOP = 10 // a finger under this counts as anchored (held), not scrolling
const SWIPE_THRESHOLD = 60 // centroid travel that fires a three-finger swipe
const DRAG_ARM_DIST = 44 // a follow-up tap within this reach can arm drag lock

const PHOSPHOR = '126, 249, 160'

type TracePoint = { x: number; y: number; t: number; g: number }

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch('/api/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

// Non-trickle ICE: gather everything, then exchange one complete SDP. Costs a
// second on connect but removes the need for a persistent signaling channel.
function iceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', done)
    setTimeout(resolve, 3000) // do not hang on an unreachable STUN server
  })
}

function haptic(ms: number) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(ms)
}


export default function Page() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [screen, setScreen] = useState('')
  const [rtt, setRtt] = useState<number | null>(null)
  const [rate, setRate] = useState(0)
  const [gainOut, setGainOut] = useState(1)
  const [sens, setSens] = useState(1)
  const [natural, setNatural] = useState(true)
  const [kbOpen, setKbOpen] = useState(false)
  const [touched, setTouched] = useState(false)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const chRef = useRef<{ ctrl: RTCDataChannel | null; input: RTCDataChannel | null }>({
    ctrl: null,
    input: null,
  })
  const padRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const kbRef = useRef<HTMLInputElement | null>(null)

  const sensRef = useRef(1)
  const naturalRef = useRef(true)
  const gainRef = useRef(1)
  const txRef = useRef(0)
  const pending = useRef({ dx: 0, dy: 0, sdx: 0, sdy: 0 })
  const trace = useRef<TracePoint[]>([])
  const fingerRef = useRef<{ x: number; y: number } | null>(null)
  const pingRef = useRef<{ id: number; sent: number }>({ id: 0, sent: 0 })

  useEffect(() => {
    sensRef.current = sens
  }, [sens])
  useEffect(() => {
    naturalRef.current = natural
  }, [natural])

  // Movement and scroll go over the unreliable channel: a dropped packet is
  // superseded a frame later, and retransmitting one would stall every packet
  // behind it. Everything else needs to arrive exactly once, in order.
  const send = useCallback((obj: { t: string; [k: string]: unknown }) => {
    const ch = chRef.current
    const dc = obj.t === 'm' || obj.t === 's' ? (ch.input ?? ch.ctrl) : ch.ctrl
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(obj))
      txRef.current++
    }
  }, [])

  // ---------------------------------------------------------------- connect

  const connect = useCallback(
    async (room: string, secret: string) => {
      setError('')
      setPhase('fetching')
      try {
        const secretHash = await sha256(secret)

        const fetched = await post({ op: 'fetch', room, secretHash })
        if (!fetched.ok) {
          throw new Error(
            fetched.error === 'expired'
              ? 'That pairing code has expired. Restart the agent on your Mac for a fresh one.'
              : fetched.error === 'unauthorized'
                ? 'Pairing rejected. The link is incomplete or was tampered with.'
                : 'Signaling server refused the request.',
          )
        }

        setPhase('negotiating')
        const pc = new RTCPeerConnection({ iceServers: ICE })
        pcRef.current = pc

        // The agent opens two channels: "ctrl" reliable and ordered, "input"
        // unreliable for movement. Both must arrive before we authenticate.
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('The Mac never opened its data channels.')),
            20000,
          )
          pc.ondatachannel = (e) => {
            const dc = e.channel
            if (dc.label === 'input') {
              chRef.current.input = dc
            } else if (dc.label === 'ctrl') {
              chRef.current.ctrl = dc

              dc.onopen = () => {
                // The agent re-checks this secret itself, so a compromised
                // signaling server (which only saw the hash) cannot drive the Mac.
                dc.send(JSON.stringify({ t: 'auth', secret }))
              }

              dc.onmessage = (ev) => {
                let msg: Record<string, unknown>
                try {
                  msg = JSON.parse(ev.data as string)
                } catch {
                  return
                }
                if (msg.t === 'ok') {
                  setScreen(typeof msg.screen === 'string' ? msg.screen : '')
                  setPhase('live')
                  haptic(18)
                  if ('wakeLock' in navigator) {
                    ;(
                      navigator as Navigator & {
                        wakeLock: { request: (t: string) => Promise<unknown> }
                      }
                    ).wakeLock
                      .request('screen')
                      .catch(() => {})
                  }
                } else if (msg.t === 'deny') {
                  setError('The Mac rejected the pairing secret. Scan the QR code again.')
                  setPhase('error')
                } else if (msg.t === 'pong' && msg.id === pingRef.current.id) {
                  setRtt(Math.round(performance.now() - pingRef.current.sent))
                }
              }

              dc.onclose = () => {
                setPhase((p) => (p === 'error' ? p : 'idle'))
                setError('Link closed. Restart the agent and scan again.')
              }
            }

            if (chRef.current.ctrl && chRef.current.input) {
              clearTimeout(timer)
              resolve()
            }
          }
        })

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            setError('Peer connection failed. If the phone and Mac are on different networks, connect both to the same Wi-Fi.')
            setPhase('error')
          }
        }

        await pc.setRemoteDescription({ type: 'offer', sdp: fetched.offer as string })
        await pc.setLocalDescription(await pc.createAnswer())
        await iceComplete(pc)

        const delivered = await post({
          op: 'answer',
          room,
          secretHash,
          answer: pc.localDescription!.sdp,
        })
        if (!delivered.ok) throw new Error('Could not hand the answer back to your Mac.')

        setPhase('waiting')
        await ready
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown failure.')
        setPhase('error')
      }
    },
    [],
  )

  // Read the pairing material out of the URL fragment. A fragment is never sent
  // to the server, so the raw secret stays client-side.
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const room = hash.get('r')
    const secret = hash.get('s')
    if (room && secret) {
      history.replaceState(null, '', window.location.pathname)
      void connect(room, secret)
    }
  }, [connect])

  // ---------------------------------------------------------------- telemetry

  useEffect(() => {
    if (phase !== 'live') return
    const ping = setInterval(() => {
      pingRef.current = { id: pingRef.current.id + 1, sent: performance.now() }
      send({ t: 'ping', id: pingRef.current.id })
    }, 2000)
    const meter = setInterval(() => {
      setRate(txRef.current)
      txRef.current = 0
      setGainOut(gainRef.current)
    }, 1000)
    return () => {
      clearInterval(ping)
      clearInterval(meter)
    }
  }, [phase, send])

  // ---------------------------------------------------------------- input

  useEffect(() => {
    if (phase !== 'live') return
    const pad = padRef.current
    if (!pad) return

    // Per-touch tracking by identifier. Reasoning about individual touches, not
    // just a finger count and a centroid, is what lets us tell a two-finger
    // scroll from a one-finger-held drag, and read a clean three-finger swipe.
    type Rec = { lx: number; ly: number; st: number; moved: number; fdx: number; fdy: number }
    const S = {
      pts: new Map<number, Rec>(),
      peak: 0,
      mode: 'none' as 'none' | 'move' | 'scroll' | 'drag' | 'swipe' | 'pending2',
      mouseDown: false,
      armDrag: false,
      tapOK: true,
      swipeFired: false,
      swipeSX: 0,
      swipeSY: 0,
      longTimer: 0,
      lastT: 0,
      lastTapEnd: -1e9,
      lastTapX: 0,
      lastTapY: 0,
      rect: null as DOMRect | null,
    }

    const clearLong = () => {
      if (S.longTimer) {
        window.clearTimeout(S.longTimer)
        S.longTimer = 0
      }
    }
    const only = (): Rec | undefined => S.pts.values().next().value
    const pair = (): Rec[] => Array.from(S.pts.values()).slice(0, 2)
    const center = () => {
      let x = 0
      let y = 0
      for (const r of S.pts.values()) {
        x += r.lx
        y += r.ly
      }
      const n = S.pts.size || 1
      return { x: x / n, y: y / n }
    }

    // Shared cursor path: the acceleration curve plus the phosphor trace point.
    const moveCursor = (dx: number, dy: number, dt: number, r: Rec) => {
      const speed = Math.hypot(dx, dy) / dt
      const gain = MIN_GAIN + (MAX_GAIN - MIN_GAIN) * (1 - Math.exp(-speed / KNEE))
      const applied = gain * sensRef.current
      gainRef.current = applied
      pending.current.dx += dx * applied
      pending.current.dy += dy * applied
      if (S.rect) {
        const p = { x: r.lx - S.rect.left, y: r.ly - S.rect.top }
        fingerRef.current = p
        trace.current.push({ x: p.x, y: p.y, t: performance.now(), g: gain })
      }
    }

    const onStart = (e: TouchEvent) => {
      e.preventDefault()
      const now = performance.now()
      S.rect = pad.getBoundingClientRect()
      setTouched(true)

      const fresh = S.pts.size === 0
      for (const t of Array.from(e.changedTouches)) {
        S.pts.set(t.identifier, { lx: t.clientX, ly: t.clientY, st: now, moved: 0, fdx: 0, fdy: 0 })
      }
      const n = S.pts.size
      S.peak = Math.max(S.peak, n)
      if (fresh) {
        S.mode = 'none'
        S.tapOK = true
        S.swipeFired = false
      }
      clearLong()

      if (n === 1) {
        const t = e.changedTouches[0]
        trace.current.length = 0
        // A tap that just happened near here arms drag lock: press and move now
        // and you are dragging (the trackpad tap, then tap-and-hold gesture).
        S.armDrag =
          now - S.lastTapEnd < DOUBLE_MS &&
          Math.hypot(t.clientX - S.lastTapX, t.clientY - S.lastTapY) < DRAG_ARM_DIST
        // Press and hold to pick up a drag with a single finger.
        S.longTimer = window.setTimeout(() => {
          const o = only()
          if (o && o.moved < TAP_SLOP && !S.mouseDown && S.pts.size === 1) {
            send({ t: 'd', b: 'l' })
            S.mouseDown = true
            S.mode = 'drag'
            S.tapOK = false
            haptic(14)
          }
        }, LONG_PRESS_MS)
      } else if (n === 2) {
        // Hold off: wait for movement to tell a scroll from a held drag.
        if (S.mode !== 'drag') S.mode = 'pending2'
      } else if (n >= 3) {
        S.mode = 'swipe'
        const c = center()
        S.swipeSX = c.x
        S.swipeSY = c.y
        S.tapOK = false
      }
      S.lastT = now
    }

    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      const now = performance.now()
      const dt = Math.max(now - S.lastT, 1)

      for (const t of Array.from(e.changedTouches)) {
        const r = S.pts.get(t.identifier)
        if (!r) continue
        r.fdx = t.clientX - r.lx
        r.fdy = t.clientY - r.ly
        r.lx = t.clientX
        r.ly = t.clientY
        r.moved += Math.hypot(r.fdx, r.fdy)
      }

      const n = S.pts.size

      if (n === 1) {
        const r = only()
        if (!r) return
        if (r.moved > TAP_SLOP) S.tapOK = false
        if (S.armDrag && !S.mouseDown && r.moved > TAP_SLOP) {
          send({ t: 'd', b: 'l' })
          S.mouseDown = true
          S.mode = 'drag'
          haptic(10)
        }
        if (S.mode === 'none') S.mode = 'move'
        moveCursor(r.fdx, r.fdy, dt, r)
      } else if (n === 2) {
        const [a, b] = pair()
        if (S.mode === 'pending2') {
          const hi = Math.max(a.moved, b.moved)
          const lo = Math.min(a.moved, b.moved)
          if (hi > CLASSIFY_SLOP) {
            if (lo < STATIONARY_SLOP) {
              // One finger anchored, the other moving: a held drag, not a scroll.
              S.mode = 'drag'
              S.tapOK = false
              if (!S.mouseDown) {
                send({ t: 'd', b: 'l' })
                S.mouseDown = true
                haptic(10)
              }
            } else {
              S.mode = 'scroll'
              S.tapOK = false
            }
          }
        }
        if (S.mode === 'scroll') {
          const sign = naturalRef.current ? 1 : -1
          let dx = 0
          let dy = 0
          let k = 0
          for (const t of Array.from(e.changedTouches)) {
            const r = S.pts.get(t.identifier)
            if (!r) continue
            dx += r.fdx
            dy += r.fdy
            k++
          }
          if (k) {
            pending.current.sdx += (dx / k) * SCROLL_GAIN * sign
            pending.current.sdy += (dy / k) * SCROLL_GAIN * sign
          }
        } else if (S.mode === 'drag') {
          const anchor = a.moved <= b.moved ? a : b
          for (const t of Array.from(e.changedTouches)) {
            const r = S.pts.get(t.identifier)
            if (!r || r === anchor) continue
            moveCursor(r.fdx, r.fdy, dt, r)
          }
        }
      } else if (n >= 3 && S.mode === 'swipe' && !S.swipeFired) {
        const c = center()
        const dx = c.x - S.swipeSX
        const dy = c.y - S.swipeSY
        if (Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_THRESHOLD) {
          S.swipeFired = true
          // Three fingers reproduce the desktop trackpad swipes through their
          // default macOS keyboard shortcuts.
          if (Math.abs(dy) >= Math.abs(dx)) {
            // up = Mission Control, down = App Expose
            send({ t: 'key', k: dy < 0 ? 'up' : 'down', m: ['ctrl'] })
          } else {
            // left or right = move one space
            send({ t: 'key', k: dx < 0 ? 'left' : 'right', m: ['ctrl'] })
          }
          haptic(22)
        }
      }
      S.lastT = now
    }

    const onEnd = (e: TouchEvent) => {
      e.preventDefault()
      const now = performance.now()
      clearLong()

      const ended = Array.from(e.changedTouches)
        .map((t) => S.pts.get(t.identifier))
        .filter((r): r is Rec => Boolean(r))
      for (const t of Array.from(e.changedTouches)) S.pts.delete(t.identifier)
      const remaining = S.pts.size

      if (remaining === 0) {
        if (S.mouseDown) {
          send({ t: 'u', b: 'l' })
          S.mouseDown = false
          haptic(8)
        } else if (S.tapOK && !S.swipeFired) {
          const quick = ended.every((r) => now - r.st < TAP_MS && r.moved < TAP_SLOP)
          if (quick) {
            if (S.peak >= 2) {
              send({ t: 'c', b: 'r' })
              haptic(16)
            } else {
              // Sent at once. The injector turns two quick taps into a native
              // double click via click state, so single clicks keep zero delay.
              send({ t: 'c', b: 'l' })
              haptic(8)
              S.lastTapEnd = now
              const o = ended[0]
              if (o) {
                S.lastTapX = o.lx
                S.lastTapY = o.ly
              }
            }
          }
        }
        S.mode = 'none'
        S.peak = 0
        S.swipeFired = false
        S.armDrag = false
        fingerRef.current = null
      } else if (remaining === 1 && (S.mode === 'pending2' || S.mode === 'scroll')) {
        // Dropped to one finger before a two-finger intent resolved: let the
        // survivor drive the cursor.
        S.mode = 'move'
      }
      S.lastT = now
    }

    pad.addEventListener('touchstart', onStart, { passive: false })
    pad.addEventListener('touchmove', onMove, { passive: false })
    pad.addEventListener('touchend', onEnd, { passive: false })
    pad.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      clearLong()
      pad.removeEventListener('touchstart', onStart)
      pad.removeEventListener('touchmove', onMove)
      pad.removeEventListener('touchend', onEnd)
      pad.removeEventListener('touchcancel', onEnd)
    }
  }, [phase, send])

  // -------------------------------------------- flush loop + phosphor trace

  useEffect(() => {
    if (phase !== 'live') return
    const canvas = canvasRef.current
    const pad = padRef.current
    if (!canvas || !pad) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let w = 0
    let h = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const r = pad.getBoundingClientRect()
      w = r.width
      h = r.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(pad)

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Caliper ticks: a machinist's scale reading the finger's position on the pad.
    const ticks = (finger: { x: number; y: number } | null) => {
      const N = 28
      ctx.lineWidth = 1
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * w
        const major = i % 4 === 0
        const near = finger !== null && Math.abs(x - finger.x) < w / N
        ctx.strokeStyle = near ? `rgba(${PHOSPHOR},0.95)` : `rgba(255,255,255,${major ? 0.13 : 0.07})`
        const len = (major ? 11 : 6) + (near ? 5 : 0)
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, len)
        ctx.stroke()
      }
      const M = 40
      for (let i = 0; i <= M; i++) {
        const y = (i / M) * h
        const major = i % 5 === 0
        const near = finger !== null && Math.abs(y - finger.y) < h / M
        ctx.strokeStyle = near ? `rgba(${PHOSPHOR},0.95)` : `rgba(255,255,255,${major ? 0.13 : 0.07})`
        const len = (major ? 11 : 6) + (near ? 5 : 0)
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(len, y)
        ctx.stroke()
      }
    }

    const frame = () => {
      const p = pending.current

      // Coalesced send: one packet per frame, never one per touchmove.
      if (p.dx || p.dy) {
        send({ t: 'm', dx: +p.dx.toFixed(2), dy: +p.dy.toFixed(2) })
        p.dx = 0
        p.dy = 0
      }
      if (p.sdx || p.sdy) {
        send({ t: 's', dx: +p.sdx.toFixed(2), dy: +p.sdy.toFixed(2) })
        p.sdx = 0
        p.sdy = 0
      }

      const now = performance.now()
      ctx.clearRect(0, 0, w, h)
      const finger = fingerRef.current
      ticks(finger)

      const pts = trace.current
      while (pts.length && now - pts[0].t > TRACE_MS) pts.shift()

      if (reduced) {
        if (finger) {
          ctx.fillStyle = `rgba(${PHOSPHOR},0.9)`
          ctx.beginPath()
          ctx.arc(finger.x, finger.y, 4, 0, Math.PI * 2)
          ctx.fill()
        }
      } else {
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]
          const b = pts[i]
          const alpha = Math.max(0, 1 - (now - b.t) / TRACE_MS)
          ctx.strokeStyle = `rgba(${PHOSPHOR},${(alpha * 0.85).toFixed(3)})`
          // Width tracks the gain, so the acceleration curve is visible.
          ctx.lineWidth = 1 + b.g * 1.1
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [phase, send])

  // ---------------------------------------------------------------- keyboard

  const ZWSP = '​'

  const onKbInput = () => {
    const el = kbRef.current
    if (!el) return
    if (el.value.length > ZWSP.length) send({ t: 'txt', s: el.value.slice(ZWSP.length) })
    else if (el.value.length < ZWSP.length) send({ t: 'key', k: 'delete' })
    el.value = ZWSP
  }

  const onKbKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const map: Record<string, string> = {
      Enter: 'return',
      Tab: 'tab',
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Escape: 'escape',
    }
    const k = map[e.key]
    if (k) {
      e.preventDefault()
      send({ t: 'key', k })
    }
  }

  const toggleKeyboard = () => {
    const el = kbRef.current
    if (!el) return
    if (kbOpen) {
      el.blur()
      setKbOpen(false)
    } else {
      el.value = ZWSP
      el.focus()
      setKbOpen(true)
    }
  }

  // ---------------------------------------------------------------- render

  if (phase !== 'live') {
    const busy = phase === 'fetching' || phase === 'negotiating' || phase === 'waiting'
    const label =
      phase === 'fetching'
        ? 'Fetching offer'
        : phase === 'negotiating'
          ? 'Negotiating peer link'
          : phase === 'waiting'
            ? 'Opening channel'
            : phase === 'error'
              ? 'Not connected'
              : 'Waiting to pair'

    return (
      <main className="screen">
        <div>
          <div className="tag">Phone Mouse</div>
          <h1>
            Precision
            <br />
            pointer
          </h1>
        </div>

        <div className="status" role="status" aria-live="polite">
          <span className={`pip ${phase === 'error' ? 'dead' : busy ? '' : ''}`} />
          {label}
          {busy ? '...' : ''}
        </div>

        {phase === 'error' && error ? <div className="err">{error}</div> : null}

        {!busy ? (
          <>
            <p className="lede">
              This page is only the input surface. The cursor is moved by a small agent
              running on your Mac, and the two talk peer to peer, so your movements never
              travel through this server.
            </p>
            <div className="steps">
              <div className="step">
                <span className="n">01</span>
                <span>
                  On your Mac, run <code>npm start</code> in the <code>agent</code> folder.
                </span>
              </div>
              <div className="step">
                <span className="n">02</span>
                <span>Grant Accessibility permission when macOS asks, then restart the agent.</span>
              </div>
              <div className="step">
                <span className="n">03</span>
                <span>Scan the QR code it prints in the terminal with this phone.</span>
              </div>
            </div>
            <p className="note">
              Pairing links carry a 128-bit secret and expire after three minutes. Opening
              this page directly, without scanning, will not connect to anything.
            </p>
          </>
        ) : (
          <p className="lede">Hold on, establishing a direct link to your Mac.</p>
        )}
      </main>
    )
  }

  return (
    <main className="stage">
      <div className="rail">
        <div className="cell">
          <span className="k">Link</span>
          <span className="v good">OK</span>
        </div>
        <div className="cell">
          <span className="k">RTT</span>
          <span className={`v ${rtt === null ? '' : rtt < 30 ? 'good' : rtt < 90 ? 'warn' : 'bad'}`}>
            {rtt === null ? '--' : `${rtt}ms`}
          </span>
        </div>
        <div className="cell">
          <span className="k">TX</span>
          <span className="v">{rate}/s</span>
        </div>
        <div className="cell">
          <span className="k">Gain</span>
          <span className="v">{gainOut.toFixed(2)}x</span>
        </div>
        <div className="cell">
          <span className="k">Screen</span>
          <span className="v">{screen || '--'}</span>
        </div>
      </div>

      <div className="pad" ref={padRef}>
        <canvas ref={canvasRef} />
        <div className="padhint" style={{ opacity: touched ? 0 : 1 }}>
          <div>drag to move &middot; tap to click</div>
          <div>double tap to double click</div>
          <div>two fingers scroll &middot; two finger tap right click</div>
          <div>three fingers up for mission control</div>
          <div>hold, or tap then hold, to drag</div>
        </div>
      </div>

      <div className="bar">
        <button onClick={() => send({ t: 'c', b: 'l' })}>Left</button>
        <button className={kbOpen ? 'on' : ''} onClick={toggleKeyboard}>
          Kbd
        </button>
        <button onClick={() => send({ t: 'c', b: 'r' })}>Right</button>
      </div>

      <div className="sens">
        <label htmlFor="sens">Sens</label>
        <input
          id="sens"
          type="range"
          min="0.4"
          max="2.2"
          step="0.05"
          value={sens}
          onChange={(e) => setSens(parseFloat(e.target.value))}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{sens.toFixed(2)}</span>
        <button
          style={{ padding: '6px 10px', borderRadius: 'var(--r-control)' }}
          className={natural ? 'on' : ''}
          onClick={() => setNatural((v) => !v)}
        >
          {natural ? 'Natural' : 'Inverted'}
        </button>
      </div>

      <input
        ref={kbRef}
        className="kbd"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onInput={onKbInput}
        onKeyDown={onKbKeyDown}
        onBlur={() => setKbOpen(false)}
        aria-label="Keyboard passthrough"
      />
    </main>
  )
}
