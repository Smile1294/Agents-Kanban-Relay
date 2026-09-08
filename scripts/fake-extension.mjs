/* A stand-in for the extension, so the page can be tried end to end without
 * VS Code.
 *
 *   node scripts/fake-extension.mjs http://localhost:8787 <pairingCode> [--read-only]
 *
 * It derives the board id the way the bridge does, pushes the sample frame
 * (scripts/sample-frame.json) plus a model catalogue, then loops: poll the
 * message queue, print each queued message, ack it, and answer a few of them
 * plausibly so the page is live rather than a snapshot:
 *
 *   select     → re-push the frame with mode:'chat' and the sample transcript
 *   search     → post a searchResults event
 *   voiceAudio → post { type:'voice', started:false, text:'(fake transcript)' }
 *   remove     → post a remote dialog event, print the answer when it arrives
 *
 * Everything else is printed and acked but otherwise ignored — same as the
 * extension would do for a message it does not recognise. Writes are on unless
 * `--read-only` is passed, which the page reads back as the READ-ONLY badge.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const readOnly = args.includes('--read-only')
const [relayUrl, code] = args.filter((a) => !a.startsWith('--'))

if (!relayUrl || !code) {
  console.error('usage: node scripts/fake-extension.mjs <relayUrl> <pairingCode> [--read-only]')
  process.exit(1)
}

const base = relayUrl.replace(/\/+$/, '')

async function deriveId(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 24)
}

const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', context: '1M', contextTokens: 1000000, price: '$5/$25 per Mtok' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', context: '200K' },
]

const id = await deriveId(code)
const writes = !readOnly
const mv = 'sample:1'
const frame = JSON.parse(await readFile(join(HERE, 'sample-frame.json'), 'utf8'))
const state = frame.state

console.log(`fake extension → ${base}  (board ${id}, writes ${writes ? 'on' : 'OFF'})`)

async function post(body) {
  const res = await fetch(base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': id },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

async function postFrame(extra) {
  await post({ kind: 'frame', at: Date.now(), writes, mv, state: { ...state, ...extra } })
}

async function postEvent(msg) {
  await post({ kind: 'event', events: [msg] })
}

async function pollMsgs() {
  try {
    const res = await fetch(base + '/board?id=' + encodeURIComponent(id) + '&msgs=1')
    const json = await res.json().catch(() => null)
    return json && Array.isArray(json.msgs) ? json.msgs : []
  } catch {
    return []
  }
}

async function ack(nonces) {
  if (!nonces.length) return
  await post({ kind: 'ack', nonces })
}

async function handleMsg(entry) {
  const msg = entry.msg
  if (!msg || typeof msg !== 'object') return
  console.log(`← ${msg.type}` + (msg.type !== 'ready' ? ' ' + JSON.stringify(msg).slice(0, 160) : ''))
  switch (msg.type) {
    case 'ready':
      break // the sample catalogue is already up
    case 'select':
      await postFrame({ mode: 'chat', selectedKey: msg.id || 'abc-123' })
      break
    case 'search': {
      const q = typeof msg.q === 'string' ? msg.q : ''
      const matches = q
        ? [{ key: 'abc-123', entryIndex: 5, at: 1757299400000, kind: 'text', snippet: q, lead: 'Found it — ' }]
        : []
      await postEvent({ type: 'searchResults', q, matches, more: 0 })
      break
    }
    case 'voiceAudio':
      await postEvent({ type: 'voice', started: false, text: '(fake transcript)' })
      break
    case 'remove':
      await postEvent({
        type: 'remote',
        kind: 'dialog',
        id: crypto.randomUUID(),
        spec: { level: 'warning', title: 'Confirmation', text: 'Delete this session and its transcript permanently?', choices: ['Delete', 'Cancel'] },
      })
      break
    case 'remote.dialog':
      console.log(`  dialog ${msg.id ?? ''} answered: ${JSON.stringify(msg.answer)}`)
      break
    default:
      console.log('  (no fake answer)')
  }
}

// Initial push: the sample frame plus the model catalogue.
console.log('pushing the sample frame + model catalogue…')
await post({ kind: 'frame', at: Date.now(), writes, mv, state, models: MODELS })

console.log('polling the message queue… (Ctrl-C to stop)')
while (true) {
  const msgs = await pollMsgs()
  for (const entry of msgs) {
    if (entry && typeof entry.nonce === 'string') await handleMsg(entry)
  }
  await ack(msgs.map((m) => m.nonce).filter(Boolean))
  await new Promise((r) => setTimeout(r, 1_000))
}
