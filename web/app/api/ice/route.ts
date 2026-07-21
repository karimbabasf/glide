import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ICE configuration, served at runtime so TURN can be turned on by setting env
// vars with no rebuild. Both the phone and the local agent fetch this.
//
// STUN alone is enough on any network that allows device-to-device traffic
// (most home and office wifi): the peers find each other and connect directly.
// TURN is only needed on client-isolated networks (some cafe, co-working, and
// guest wifi) that block peer-to-peer; there it relays the stream.
//
// To enable TURN, set EITHER:
//   Cloudflare (free, recommended): CF_TURN_TOKEN_ID, CF_TURN_API_TOKEN
//   or static creds (coturn, Twilio): TURN_URLS (comma separated), TURN_USERNAME, TURN_CREDENTIAL

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

async function cloudflareTurn(): Promise<RTCIceServer[] | null> {
  const id = process.env.CF_TURN_TOKEN_ID
  const token = process.env.CF_TURN_API_TOKEN
  if (!id || !token) return null
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        cache: 'no-store',
      },
    )
    if (!res.ok) return null
    const j = (await res.json()) as { iceServers?: RTCIceServer }
    return j.iceServers ? [j.iceServers] : null
  } catch {
    return null
  }
}

function staticTurn(): RTCIceServer[] {
  const urls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!urls.length) return []
  return [
    {
      urls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    },
  ]
}

export async function GET() {
  const turn = (await cloudflareTurn()) || staticTurn()
  return NextResponse.json(
    { iceServers: [...STUN, ...turn], relay: turn.length > 0 },
    { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } },
  )
}

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}
