/* The Cloudflare host, exercised against a fake KV — no account, no wrangler.
 * The worker is a store adapter plus a routing guard, so this pins the two
 * things that could silently break: KV's list shape (`keys: [{ name }]`) must
 * become board-core's (`blobs: [{ key }]`), and everything that is not /board
 * must not reach the relay — plus the new v2 query params (`since`, `models`,
 * `msgs`, `wait`) passing through to handle().
 */
import worker, { kvStore } from '../worker.js'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** KV's surface, over a Map — just enough for the adapter. */
function fakeKV() {
  const m = new Map()
  return {
    map: m,
    async put(k, v) { m.set(k, v) },
    async get(k) { return m.has(k) ? m.get(k) : null },
    async delete(k) { m.delete(k) },
    async list({ prefix }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))
      return { keys }
    },
  }
}

// --- the KV adapter -----------------------------------------------------------

{
  const kv = fakeKV()
  const store = kvStore({ BOARDS: kv })
  await store.set('s:x', '{"seq":1}')
  ok((await store.get('s:x')) === '{"seq":1}', 'get reads KV')
  const { blobs } = await store.list({ prefix: 's:' })
  ok(blobs.length === 1 && blobs[0].key === 's:x',
    'KV list keys (name) become board-core blobs (key) — the mapping the GC depends on')
  await store.delete('s:x')
  ok((await store.get('s:x')) === null, 'delete removes from KV')
}

// --- routing and the relay through the worker ---------------------------------

const ID = 'a'.repeat(24)
const env = { BOARDS: fakeKV() }
const json = (method, body, extra = {}) => new Request('https://x.example/board', {
  method,
  headers: { 'content-type': 'application/json', 'x-rc-key': ID, ...extra },
  body: JSON.stringify(body),
})

{
  const miss = await worker.fetch(new Request('https://x.example/board.css'), env)
  ok(miss.status === 404, 'a path that is not /board is refused by the worker — assets serve it, not the relay')

  const pushed = await worker.fetch(json('POST', {
    kind: 'frame', at: 1000, writes: false, mv: 'v1',
    state: { ready: true, mode: 'kanban' },
    models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
  }), env)
  ok(pushed.status === 200 && (await pushed.json()).ok === true, 'a frame goes through the worker')

  const got = await worker.fetch(new Request('https://x.example/board?id=' + ID), env)
  const g = await got.json()
  ok(g.ok === true && g.frame && g.frame.state.ready === true, 'the frame reads back')

  const models = await worker.fetch(new Request('https://x.example/board?id=' + ID + '&models=1'), env)
  const m = await models.json()
  ok(m.models && m.models[0].label === 'Opus 5', 'the worker passes models=1 through to the relay')

  const queued = await worker.fetch(json('POST', { kind: 'msg', nonce: 'n1', msg: { type: 'select', id: 'abc' } }), env)
  ok(queued.status === 200, 'a message is queued through the worker')
  const msgs = await worker.fetch(new Request('https://x.example/board?id=' + ID + '&msgs=1'), env)
  ok((await msgs.json()).msgs.length === 1, 'the worker passes msgs=1 through to the relay')

  // wait is accepted and ignored here — the answer must not claim longPoll.
  const waited = await worker.fetch(new Request('https://x.example/board?id=' + ID + '&since=1&wait=25'), env)
  const w = await waited.json()
  ok(waited.status === 200 && w.longPoll === undefined, 'the worker ignores wait and never claims longPoll')

  const noKey = await worker.fetch(new Request('https://x.example/board?id=' + ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'frame', at: 2000, writes: false, mv: '', state: { ready: true } }),
  }), env)
  ok(noKey.status === 401, 'the write gate holds in the worker too')
}

console.log(fails ? `\n${fails} failure(s)` : '\nworker: all ok')
process.exit(fails ? 1 : 0)
