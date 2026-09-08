/* The plain-Node host, exercised for real: server.js is spawned as a child
 * process on an ephemeral port with a throwaway data directory, and the relay
 * contract — frame round-trips, the static page, the media/bridge routes, the
 * 5 MB body bound, and true long-poll (`wait`) — is driven over real HTTP.
 *
 * This is the deployable the howToTest rides on, and the only host that holds
 * a request open, so the long-poll behaviour is pinned here.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server.js')

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** Spawn the server, resolve once its startup line names the real port
 *  (PORT=0 picks an ephemeral one). */
function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0', RC_DATA: dataDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the server never reported its port'))
    }, 10_000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /relay on http:\/\/localhost:(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child, base: `http://localhost:${m[1]}` })
      }
    })
  })
}

const stop = (child) => new Promise((resolve) => {
  child.on('exit', () => resolve())
  child.kill('SIGTERM')
})

const ID = 'a'.repeat(24)
const STATE = { ready: true, mode: 'kanban', columns: [], cards: [] }
const frame = (at, state = STATE, models) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-rc-key': ID },
  body: JSON.stringify({ kind: 'frame', at, writes: false, mv: 'v1', state, models }),
})

const tmp = await mkdtemp(join(tmpdir(), 'rc-relay-'))
const s1 = await startServer(tmp)

// --- static page and routes --------------------------------------------------

{
  const home = await fetch(s1.base + '/')
  ok(home.status === 200 && (await home.text()).includes('Remote board'),
    'the site root serves the page')
  const theme = await fetch(s1.base + '/media/theme.css')
  ok(theme.status === 200 && (theme.headers.get('content-type') || '').includes('text/css'),
    'media/theme.css serves with a css content type')
  const boardCss = await fetch(s1.base + '/media/board.css')
  ok(boardCss.status === 200 && (boardCss.headers.get('content-type') || '').includes('text/css'),
    'media/board.css serves with a css content type')
  const boardJs = await fetch(s1.base + '/media/board.js')
  ok(boardJs.status === 200 && (await boardJs.text()).includes('acquireVsCodeApi'),
    'media/board.js serves, and is the real webview script')
  const bridgeJs = await fetch(s1.base + '/bridge.js')
  ok(bridgeJs.status === 200 && (await bridgeJs.text()).includes('acquireVsCodeApi'),
    'bridge.js serves, and defines the webview API')
  const bridgeCss = await fetch(s1.base + '/bridge.css')
  ok(bridgeCss.status === 200 && (bridgeCss.headers.get('content-type') || '').includes('text/css'),
    'bridge.css serves with a css content type')
  const miss = await fetch(s1.base + '/board.css/../server.js')
  ok(miss.status === 404, 'a path that is not on the whitelist is 404, never a file')
}

// --- the frame round trip ----------------------------------------------------

{
  const before = await fetch(s1.base + '/board?id=' + ID)
  ok(before.status === 404, 'no board yet: the first push has not happened')
  const pushed = await fetch(s1.base + '/board', frame(1000, { ready: true }))
  ok(pushed.status === 200 && (await pushed.json()).ok === true, 'a frame is accepted')
  const got = await fetch(s1.base + '/board?id=' + ID)
  const json = await got.json()
  ok(got.status === 200 && json.frame && json.frame.state.ready === true,
    'the frame reads back over HTTP')
  ok(json.longPoll === true, 'a plain Node GET answer carries longPoll:true')
  const noKey = await fetch(s1.base + '/board?id=' + ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'frame', at: 2000, writes: false, mv: '', state: { ready: true } }),
  })
  ok(noKey.status === 401, 'a POST without the board key is refused — the write gate holds over HTTP')
}

// --- the model catalogue and the message queue, end to end -------------------

{
  const post = (body) => fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': ID },
    body: JSON.stringify(body),
  })
  const pushed = await post({ kind: 'frame', at: 3000, writes: false, mv: 'v2', state: STATE, models: [{ id: 'claude-opus-5', label: 'Opus 5' }] })
  ok(pushed.status === 200, 'a frame with a model catalogue is accepted')
  const models = await fetch(s1.base + '/board?id=' + ID + '&models=1')
  const mjson = await models.json()
  ok(models.status === 200 && mjson.mv === 'v2' && mjson.models[0].label === 'Opus 5',
    'the catalogue reads back on ?models=1')

  const queued = await post({ kind: 'msg', nonce: 'n1', msg: { type: 'select', id: 'abc' } })
  ok(queued.status === 200, 'a message is queued')
  const poll = await fetch(s1.base + '/board?id=' + ID + '&msgs=1')
  const { msgs } = await poll.json()
  ok(Array.isArray(msgs) && msgs.length === 1 && msgs[0].nonce === 'n1', 'the message reads back on ?msgs=1')
  const acked = await post({ kind: 'ack', nonces: ['n1'] })
  ok(acked.status === 200, 'the ack is accepted')
}

// --- the body bound: 5 MB reaches the handler, 6 MB is refused at transport ---

{
  const bigState = { blob: 'x'.repeat(4_900_000) } // over the 4 MB frame cap, under the 5 MB transport
  const five = await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': ID },
    body: JSON.stringify({ kind: 'frame', at: 1, writes: false, mv: '', state: bigState }),
  })
  ok(five.status === 413 && (await five.json()).error.includes('larger than the relay'),
    'a ~5 MB body reaches the handler — its own frame cap answers, not the transport')

  const six = await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': ID },
    body: 'x'.repeat(6 * 1024 * 1024),
  })
  ok(six.status === 413 && (await six.json()).error.includes('request body too large'),
    'a 6 MB body is refused 413 at the transport, not buffered')
}

// --- true long-poll ----------------------------------------------------------

{
  const start = Date.now()
  const lp = fetch(s1.base + '/board?id=' + ID + '&since=2&wait=5')
  // Give the poll a moment to hold, then push a new frame mid-wait.
  await new Promise((r) => setTimeout(r, 300))
  const pushed = await fetch(s1.base + '/board', frame(Date.now(), { ready: true, v: 2 }))
  ok(pushed.status === 200, 'the frame that wakes the long-poll is accepted')
  const res = await lp
  const json = await res.json()
  ok(Date.now() - start < 4_500, 'a wait poll returns EARLY when a frame lands mid-wait')
  ok(json.longPoll === true && json.seq === 3, '…and it sees the new frame')
}

// --- persistence across a restart --------------------------------------------

await stop(s1.child)
const s2 = await startServer(tmp)
{
  const got = await fetch(s2.base + '/board?id=' + ID)
  const json = await got.json()
  ok(got.status === 200 && json.frame && json.frame.state.v === 2,
    'the board survives a restart — the store is a file, not memory')
}
await stop(s2.child)
await rm(tmp, { recursive: true, force: true })

console.log(fails ? `\n${fails} failure(s)` : '\nnode relay server: all ok')
process.exit(fails ? 1 : 0)
