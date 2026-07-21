// Probes candidate TURN servers: does each one hand out a relay candidate?
// A relay candidate is what makes WebRTC work on client-isolated networks
// (cafe / co-working / guest wifi) where direct peer-to-peer is blocked.

import { RTCPeerConnection } from 'node-datachannel/polyfill'
import nodeDataChannel from 'node-datachannel'

const candidates = [
  {
    name: 'metered-openrelay (static)',
    ice: [
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
  {
    name: 'metered-global (static)',
    ice: [
      { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
]

async function relayCount(ice) {
  const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: 'all' })
  pc.createDataChannel('probe')
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise((res) => {
    const t = setTimeout(res, 9000)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        res()
      }
    }
  })
  const sdp = pc.localDescription?.sdp || ''
  pc.close()
  return {
    relay: (sdp.match(/^a=candidate.* typ relay/gm) || []).length,
    srflx: (sdp.match(/typ srflx/g) || []).length,
    total: (sdp.match(/^a=candidate/gm) || []).length,
  }
}

for (const c of candidates) {
  try {
    const r = await relayCount(c.ice)
    const ok = r.relay > 0 ? 'WORKS' : 'no relay'
    console.log(`${ok.padEnd(9)} ${c.name}: ${r.total} candidates, ${r.relay} relay, ${r.srflx} srflx`)
  } catch (e) {
    console.log(`error     ${c.name}: ${e.message}`)
  }
}
nodeDataChannel.cleanup()
process.exit(0)
