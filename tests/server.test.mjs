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

// --- the message queue holds open too ----------------------------------------
//
// The page has long-polled for FRAMES since v2; the pushing machine polled the
// message QUEUE on a timer, so a tap sat there for up to a full interval before
// the machine looked. Measured end to end that was one of two 0-2000 ms waits
// either side of the work — together ~2 s of a ~2.2 s round trip.

{
  const BOARD = 'a'.repeat(23) + 'b'
  await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'frame', at: Date.now(), writes: true, mv: 'v1', state: STATE }),
  })

  // Nothing queued: the request is HELD, not answered empty straight away.
  const start = Date.now()
  const held = fetch(s1.base + `/board?id=${BOARD}&msgs=1&wait=3`)
  await new Promise((r) => setTimeout(r, 300))
  const queued = await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'msg', nonce: 'tap-1', msg: { type: 'select', id: 'x' } }),
  })
  ok(queued.status === 200, 'the tap is queued while the machine is holding a poll open')

  const res = await held
  const took = Date.now() - start
  const json = await res.json()
  ok(json.msgs && json.msgs.length === 1 && json.msgs[0].nonce === 'tap-1',
    'the held poll returns the tap')
  ok(took < 2_000, `…and returns as soon as it lands, not at the timeout (${took}ms)`)
  ok(json.longPoll === true, '…and says the host holds, so the machine may loop straight back')
}

{
  // The lock, which is the way this could go badly wrong. board-core serialises
  // per board id; a held request that kept that lock would block every write to
  // the same board for the whole wait — the exact opposite of the point.
  const BOARD = 'a'.repeat(22) + 'cd'
  await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'frame', at: Date.now(), writes: true, mv: 'v1', state: STATE }),
  })
  const held = fetch(s1.base + `/board?id=${BOARD}&msgs=1&wait=4`)
  await new Promise((r) => setTimeout(r, 150))

  const t = Date.now()
  const push = await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'frame', at: Date.now(), writes: true, mv: 'v1', state: { ...STATE, v: 9 } }),
  })
  const pushTook = Date.now() - t
  ok(push.status === 200 && pushTook < 1_000,
    `a frame push is NOT blocked by a held poll on the same board (${pushTook}ms)`)

  const read = await (await fetch(s1.base + `/board?id=${BOARD}`)).json()
  ok(read.frame.state.v === 9, '…and it really landed')
  // Release the held poll so the suite does not wait it out.
  await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'msg', nonce: 'release', msg: { type: 'ready' } }),
  })
  await held
}

// --- patch frames over real HTTP ---------------------------------------------
//
// The 97%-of-a-frame transcript, sent once. Driven end to end here because the
// query param, the answer fields and the composed frame each pass through a
// different file (server.js builds the request, board-core composes, the ring
// decides) and a unit test of any one of them would not notice the others.

{
  const BOARD = 'f'.repeat(24)
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'text', text: 'row ' + i }))
  const push = (body) => fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify(body),
  }).then((r) => r.json())

  const first = await push({
    kind: 'frame', at: Date.now(), writes: true, mv: 'v1',
    state: { ready: true, mode: 'chat', selectedKey: 'a', cards: [], transcript: rows(50) },
  })
  ok(first.patches === true, 'the host answers `patches` so a pusher can learn it speaks v3')
  ok(first.frameSeq === 1, '…and names the base for the next patch')

  const patched = await push({
    kind: 'frame', at: Date.now(), writes: true, mv: 'v1',
    patch: {
      base: first.frameSeq,
      state: { ready: true, mode: 'chat', selectedKey: 'a', cards: [], running: 1 },
      rows: { from: 50, rows: [{ kind: 'text', text: 'row 50' }] },
    },
  })
  ok(!patched.needFrame && patched.frameSeq === 2, 'a patch naming the held frame is composed')

  const whole = await (await fetch(s1.base + `/board?id=${BOARD}`)).json()
  ok(whole.frame.state.transcript.length === 51,
    'a first load gets the COMPOSED board — 51 rows, though only one of them was ever pushed twice')

  const asked = await (await fetch(s1.base + `/board?id=${BOARD}&since=1&d=1`)).json()
  ok(Array.isArray(asked.deltas) && asked.deltas.length === 1 && !asked.frame,
    'a page that asked for patches and can place them gets the patch, not the board')
  const plain = await (await fetch(s1.base + `/board?id=${BOARD}&since=1`)).json()
  ok(plain.frame && !plain.deltas, 'a page that did not ask still gets the whole board')

  const stale = await push({
    kind: 'frame', at: Date.now(), writes: true, mv: 'v1',
    patch: { base: 999, state: { ready: true, mode: 'chat', cards: [] } },
  })
  ok(stale.needFrame === true, 'a patch the host cannot place is refused, over the wire as in the unit')

  // The bytes, on the wire, for the thing this whole change exists for.
  const bigRows = Array.from({ length: 400 }, (_, i) => ({ kind: 'text', text: 'Lorem ipsum dolor sit amet. '.repeat(12) + i }))
  const keyframe = JSON.stringify({
    kind: 'frame', at: 1, writes: true, mv: 'v1',
    state: { ready: true, mode: 'chat', selectedKey: 'a', cards: [], transcript: bigRows },
  })
  const delta = JSON.stringify({
    kind: 'frame', at: 1, writes: true, mv: 'v1',
    patch: {
      base: 1, state: { ready: true, mode: 'chat', selectedKey: 'a', cards: [], running: 1 },
      rows: { from: 399, rows: [bigRows[399]] },
    },
  })
  ok(delta.length * 20 < keyframe.length,
    `a patch is at least 20x smaller on the wire (${delta.length} vs ${keyframe.length} bytes)`)
}

// --- concurrency: no write is lost, and none answers 500 ----------------------
//
// Every branch of board-core is a read-modify-write across `await` points, and
// this host serves requests concurrently. Two bugs lived in that gap and both
// were measured before they were fixed: overlapping saves raced on ONE
// `store.json.tmp` (the first rename moved it out from under the second, which
// threw ENOENT and answered 500 — 37 of 200 posts), and interleaved
// read-modify-writes lost queue entries and collided the clock's `seq` (200
// posts, 3 answered 200, 40 in the queue). A 500 on a `msg` post is a button
// somebody pressed on the remote page that silently did nothing; a colliding
// `seq` files a frame under a number a watching page has already passed, and
// that page never sees it.

{
  const BOARD = 'b'.repeat(24)
  await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
    body: JSON.stringify({ kind: 'frame', at: Date.now(), writes: true, mv: 'v1', state: STATE }),
  })

  const N = 120
  const statuses = await Promise.all(Array.from({ length: N }, (_, i) =>
    fetch(s1.base + '/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
      body: JSON.stringify({ kind: 'msg', nonce: 'n' + i, msg: { type: 'select', id: 'x' + i } }),
    }).then((r) => r.status)))

  const accepted = statuses.filter((x) => x === 200).length
  const refused = statuses.filter((x) => x === 429).length
  const failed = statuses.filter((x) => x >= 500).length
  ok(failed === 0, `no concurrent write answers 5xx (got ${failed} of ${N})`)

  const queued = await (await fetch(s1.base + `/board?id=${BOARD}&msgs=1`)).json()
  ok(queued.msgs.length === 40, 'the queue holds exactly its cap — msgMax, not "whichever writes won"')
  ok(accepted === 40 && refused === N - 40,
    `every accepted post is IN the queue: ${accepted} accepted, ${refused} refused with 429`)

  // The clock is the number both ends agree on. Concurrent events must each
  // get their own seq — a collision is a frame a watching page never sees.
  const before = (await (await fetch(s1.base + `/board?id=${BOARD}`)).json()).seq
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    fetch(s1.base + '/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rc-key': BOARD },
      body: JSON.stringify({ kind: 'event', events: [{ type: 'searchResults', n: i }] }),
    })))
  const after = (await (await fetch(s1.base + `/board?id=${BOARD}`)).json()).seq
  ok(after === before + 20,
    `20 concurrent events advance seq by exactly 20 (${before} -> ${after})`)
}

{
  // TWO boards at once. The per-board mutex deliberately does not serialise
  // across boards — one board's slow write must not hold up another's poll —
  // but every board shares ONE store.json, so the save itself is what has to
  // be safe. This is the case that fails on a shared `store.json.tmp` while
  // the single-board case above passes.
  const boards = ['c'.repeat(24), 'd'.repeat(24), 'e'.repeat(24)]
  const posts = []
  for (let i = 0; i < 30; i++) {
    for (const b of boards) {
      posts.push(fetch(s1.base + '/board', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rc-key': b },
        body: JSON.stringify({ kind: 'event', events: [{ type: 'searchResults', n: i }] }),
      }).then((r) => r.status))
    }
  }
  const statuses = await Promise.all(posts)
  const failed = statuses.filter((x) => x >= 500).length
  ok(failed === 0, `concurrent writes across boards share one store file and none fails (${failed} of ${statuses.length})`)
  for (const b of boards) {
    const { seq } = await (await fetch(s1.base + `/board?id=${b}`)).json()
    ok(seq === 30, `board ${b.slice(0, 1)} counted all 30 of its own events (seq ${seq})`)
  }
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
