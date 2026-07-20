// Short-lived storage for the WebRTC handshake. An entry lives for at most
// TTL_SECONDS and is deleted the moment the agent collects its answer.
//
// Two backends. Upstash is used when its env vars are present; otherwise this
// falls back to instance memory, which is fine for a single-user tool (the whole
// handshake completes in a few seconds on a warm instance) but will fail if the
// two requests land on different instances. Set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN to make it deterministic.

export type Entry = {
  offer: string
  secretHash: string
  answer?: string
  createdAt: number
}

const TTL_SECONDS = 180
const TTL_MS = TTL_SECONDS * 1000

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN)

const mem: Map<string, Entry> =
  ((globalThis as Record<string, unknown>).__pmStore as Map<string, Entry>) ??
  ((globalThis as Record<string, unknown>).__pmStore = new Map<string, Entry>())

function sweep() {
  const now = Date.now()
  for (const [k, v] of mem) if (now - v.createdAt > TTL_MS) mem.delete(k)
}

async function redisCmd(cmd: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`upstash ${res.status}`)
  const json = (await res.json()) as { result?: unknown }
  return json.result
}

export async function get(room: string): Promise<Entry | null> {
  if (useRedis) {
    const raw = (await redisCmd(['GET', `pm:${room}`])) as string | null
    return raw ? (JSON.parse(raw) as Entry) : null
  }
  sweep()
  return mem.get(room) ?? null
}

export async function set(room: string, entry: Entry): Promise<void> {
  if (useRedis) {
    await redisCmd(['SET', `pm:${room}`, JSON.stringify(entry), 'EX', TTL_SECONDS])
    return
  }
  sweep()
  mem.set(room, entry)
}

export async function del(room: string): Promise<void> {
  if (useRedis) {
    await redisCmd(['DEL', `pm:${room}`])
    return
  }
  mem.delete(room)
}

export function storeMode(): 'redis' | 'memory' {
  return useRedis ? 'redis' : 'memory'
}
