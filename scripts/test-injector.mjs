// Confirms macOS is actually letting the injector post events.
// Without Accessibility permission CGEvent.post fails silently, so the only
// honest check is whether the cursor physically moved.

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INJECTOR = path.join(HERE, '..', 'agent', 'injector')

if (!existsSync(INJECTOR)) {
  console.error('injector not built. Run: cd agent && npm run build')
  process.exit(1)
}

const proc = spawn(INJECTOR, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = readline.createInterface({ input: proc.stdout })

const waitFor = (prefix) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${prefix}"`)), 5000)
    const onLine = (line) => {
      if (line.startsWith(prefix)) {
        clearTimeout(timer)
        rl.off('line', onLine)
        resolve(line)
      }
    }
    rl.on('line', onLine)
  })

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const ready = await waitFor('ready')
  console.log(`injector up (${ready.slice(6)})`)

  send({ t: 'pos' })
  const before = await waitFor('pos ')

  send({ t: 'm', dx: 60, dy: 60 })
  await pause(250)

  send({ t: 'pos' })
  const after = await waitFor('pos ')

  send({ t: 'm', dx: -60, dy: -60 }) // put it back
  await pause(150)

  console.log(`before: ${before.slice(4)}`)
  console.log(`after:  ${after.slice(4)}`)

  if (before === after) {
    console.log('\nBLOCKED: the cursor did not move.')
    console.log('Grant Accessibility to your terminal:')
    console.log('  System Settings > Privacy & Security > Accessibility')
    console.log('then restart the agent.')
    process.exitCode = 1
  } else {
    console.log('\nWORKING: cursor moved, Accessibility permission is granted.')
  }
} catch (e) {
  console.error(`failed: ${e.message}`)
  process.exitCode = 1
} finally {
  proc.stdin.end()
  proc.kill()
}
