import { NextResponse } from 'next/server'
import { get, set, del, storeMode } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SDP = 20_000

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

// The server only ever sees SHA-256(secret). The raw secret travels in the QR
// code and is re-checked by the agent over the DataChannel, so even a fully
// compromised signaling server cannot take control of the desktop.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const isRoom = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9]{6,32}$/.test(v)
const isHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const isSdp = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return bad('invalid json')
  }

  const { op, room } = body
  if (!isRoom(room)) return bad('bad room')

  switch (op) {
    case 'publish': {
      if (!isSdp(body.offer)) return bad('bad offer')
      if (!isHash(body.secretHash)) return bad('bad secretHash')
      await set(room, {
        offer: body.offer,
        secretHash: body.secretHash,
        createdAt: Date.now(),
      })
      return NextResponse.json({ ok: true, store: storeMode() })
    }

    case 'fetch': {
      const entry = await get(room)
      if (!entry) return bad('expired', 404)
      if (!isHash(body.secretHash) || !constantTimeEqual(entry.secretHash, body.secretHash))
        return bad('unauthorized', 403)
      return NextResponse.json({ ok: true, offer: entry.offer })
    }

    case 'answer': {
      const entry = await get(room)
      if (!entry) return bad('expired', 404)
      if (!isHash(body.secretHash) || !constantTimeEqual(entry.secretHash, body.secretHash))
        return bad('unauthorized', 403)
      if (!isSdp(body.answer)) return bad('bad answer')
      await set(room, { ...entry, answer: body.answer })
      return NextResponse.json({ ok: true })
    }

    case 'poll': {
      const entry = await get(room)
      if (!entry) return bad('expired', 404)
      if (!isHash(body.secretHash) || !constantTimeEqual(entry.secretHash, body.secretHash))
        return bad('unauthorized', 403)
      if (!entry.answer) return NextResponse.json({ ok: true, pending: true })
      await del(room)
      return NextResponse.json({ ok: true, answer: entry.answer })
    }

    default:
      return bad('bad op')
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}
