/* The Cloudflare host, exercised against a fake KV — no account, no wrangler.
 * The worker is a store adapter plus a routing guard, so this pins the two
 * things that could silently break: KV's list shape (`keys: [{ name }]`) must
 * become board-core's (`blobs: [{ key }]`) or the orphan-tail GC dies quietly,
 * and everything that is not /board must not reach the relay.
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
  await store.set('i:x', '{"v":1}')
  await store.set('t:x:a', 'tail')
  ok((await store.get('i:x')) === '{"v":1}', 'get reads KV')
  const { blobs } = await store.list({ prefix: 't:x:' })
  ok(blobs.length === 1 && blobs[0].key === 't:x:a',
    'KV list keys (name) become board-core blobs (key) — the mapping the GC depends on')
  await store.delete('i:x')
  ok((await store.get('i:x')) === null, 'delete removes from KV')
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

  const index = {
    v: 1, at: 1000, writes: false,
    columns: [{ id: 'backlog', name: 'Backlog' }],
    sessions: { abc: { key: 'abc', title: 'Fix it', phase: 'backlog', tags: [], archived: false, updated: 1000, tv: 1 } },
  }
  const pushed = await worker.fetch(json('POST', { kind: 'update', index, tails: [] }), env)
  ok(pushed.status === 200 && (await pushed.json()).ok === true, 'an update goes through the worker')

  const queued = await worker.fetch(json('POST', { kind: 'command', nonce: 'n1', text: 'go', session: 'abc' }), env)
  ok(queued.status === 200, 'a command is queued through the worker')

  const got = await worker.fetch(new Request('https://x.example/board?id=' + ID + '&cmds=1'), env)
  const { cmds } = await got.json()
  ok(Array.isArray(cmds) && cmds.length === 1 && cmds[0].nonce === 'n1', 'the queue reads back')

  const acked = await worker.fetch(json('POST', { kind: 'ack', nonces: ['n1'] }), env)
  ok(acked.status === 200, 'the ack is accepted')
  const empty = await worker.fetch(new Request('https://x.example/board?id=' + ID + '&cmds=1'), env)
  ok((await empty.json()).cmds.length === 0, '…and the queue is empty after it')

  const noKey = await worker.fetch(new Request('https://x.example/board?id=' + ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'update', index, tails: [] }),
  }), env)
  ok(noKey.status === 401, 'the write gate holds in the worker too')
}

console.log(fails ? `\n${fails} failure(s)` : '\nworker: all ok')
process.exit(fails ? 1 : 0)
