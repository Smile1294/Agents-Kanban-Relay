/* The relay's logic, exercised in its own repository against a fake store.
 *
 * Contract v2: the relay carries the extension's OWN board webview — the frame
 * (`{ type:'state', state }`), the model catalogue, the host→page event ring,
 * and the page→host message queue. This file pins the write gate, the storage
 * names, the monotonic clock, the frame's replace-not-merge, the event ring's
 * retention, the message queue's validation, and every GET shape.
 */
import { handle, ID_OK, NONCE_OK, TYPE_OK, MSG_MAX, MSG_MAX_BYTES, FRAME_MAX_BYTES, EVENTS_MAX } from '../functions/board-core.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** A blob store in a Map, with just enough of @netlify/blobs' surface, plus
 *  a record of every key read and written so the cheap-poll and viewer-throttle
 *  claims can be pinned. */
function fakeStore() {
  const m = new Map()
  const reads = []
  const writes = []
  return {
    map: m, reads, writes,
    async set(k, v) { m.set(k, v); writes.push(k) },
    async get(k) { reads.push(k); return m.has(k) ? m.get(k) : null },
    async delete(k) { m.delete(k) },
    async list({ prefix }) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }
    },
  }
}

const ID = 'a'.repeat(24) // any 24 hex chars: the derived board id
const STATE = { ready: true, mode: 'kanban', columns: [], cards: [] }
const frameBody = (over = {}) => ({ kind: 'frame', at: 1000, writes: false, mv: 'v1', state: STATE, ...over })
const post = (store, over = {}) => handle({
  method: 'POST', boardId: ID, key: ID, body: frameBody(), ...over,
}, store)

// --- the write gate ----------------------------------------------------------

{
  const store = fakeStore()
  const missing = await handle({ method: 'POST', boardId: ID, key: '', body: frameBody() }, store)
  ok(missing.status === 401, 'a POST without the board key is refused')
  const wrong = await handle({ method: 'POST', boardId: ID, key: 'b'.repeat(24), body: frameBody() }, store)
  ok(wrong.status === 401, 'a POST with another board’s key is refused')
  const badId = await handle({ method: 'POST', boardId: 'not-hex!', key: 'not-hex!', body: frameBody() }, store)
  ok(badId.status === 400, 'a board address that is not 24 hex chars is refused')
  ok(store.map.size === 0, '…and nothing was stored by any of them')
}

// --- a frame stores the clock, the frame and the models ----------------------

{
  const store = fakeStore()
  const r = await post(store, { body: frameBody({ state: { ready: true }, models: [{ id: 'm1', label: 'M1' }] }) })
  ok(r.status === 200 && r.json.ok === true, 'a frame is accepted')
  const keys = [...store.map.keys()].sort()
  ok(keys.join(',') === `f:${ID},m:${ID},s:${ID}`, 'the frame, model and clock blobs derive from the board id')
  const s = JSON.parse(store.map.get(`s:${ID}`))
  ok(s.seq === 1 && s.frameSeq === 1 && s.at === 1000 && s.mv === 'v1' && s.writes === false,
    'the clock bumps seq and frameSeq once, and records at/mv/writes')
  const f = JSON.parse(store.map.get(`f:${ID}`))
  ok(f.seq === 1 && f.frame.type === 'state' && f.frame.state.ready === true,
    'the stored frame is { seq, frame:{ type:"state", state } }')
  const m = JSON.parse(store.map.get(`m:${ID}`))
  ok(m.mv === 'v1' && m.models[0].id === 'm1', 'the models are stored under m: with the mv')
}

// --- a heartbeat (no state) leaves seq alone ---------------------------------

{
  const store = fakeStore()
  await post(store, { body: frameBody() })
  const hb = await post(store, { body: { kind: 'frame', at: 2000, writes: false, mv: 'v1' } })
  ok(hb.status === 200, 'a heartbeat frame (state absent) is accepted')
  const s = JSON.parse(store.map.get(`s:${ID}`))
  ok(s.seq === 1 && s.frameSeq === 1 && s.at === 2000,
    '…and it updates at but leaves seq and frameSeq alone')
  const f = JSON.parse(store.map.get(`f:${ID}`))
  ok(f.seq === 1 && f.frame.state.ready === true, 'the frame blob still holds the first frame, untouched')
}

// --- an oversize frame is refused --------------------------------------------

{
  const store = fakeStore()
  const huge = await post(store, {
    body: { kind: 'frame', at: 1, writes: false, mv: '', state: { blob: 'x'.repeat(FRAME_MAX_BYTES + 1) } },
  })
  ok(huge.status === 413, 'a frame whose JSON exceeds frameMaxBytes is refused 413')
  ok(store.map.size === 0, '…and nothing was stored')
}

// --- the old kinds are refused, naming v2 ------------------------------------

{
  const store = fakeStore()
  const upd = await post(store, { body: { kind: 'update', index: {}, tails: [] } })
  ok(upd.status === 400 && upd.json.error.includes('v2'), 'the old "update" kind is refused, naming v2')
  const cmd = await post(store, { body: { kind: 'command', nonce: 'n1', text: 'go' } })
  ok(cmd.status === 400 && cmd.json.error.includes('v2'), 'the old "command" kind is refused, naming v2')
  ok(store.map.size === 0, '…and neither stored anything')
}

// --- the event ring ----------------------------------------------------------

{
  const store = fakeStore()
  const r = await post(store, { body: { kind: 'event', events: [{ type: 'note', i: 1 }, { type: 'note', i: 2 }] } })
  ok(r.status === 200 && r.json.seq === 2, 'events are appended with a monotonic seq')
  const bad = await post(store, { body: { kind: 'event', events: [{ nope: true }] } })
  ok(bad.status === 400 && bad.json.error.includes('type'), 'an event without a valid type is refused')
  const badType = await post(store, { body: { kind: 'event', events: [{ type: '1bad' }] } })
  ok(badType.status === 400, 'an event type that is not typeOk-shaped is refused')

  // Ring retention: push past EVENTS_MAX and the oldest drop off.
  const many = Array.from({ length: EVENTS_MAX + 5 }, (_, i) => ({ type: 'note', i }))
  await post(store, { body: { kind: 'event', events: many } })
  const ring = JSON.parse(store.map.get(`e:${ID}`))
  ok(ring.length === EVENTS_MAX && ring[0].seq === 2 + 6, 'the ring keeps at most eventsMax, dropping the oldest')
  const early = await handle({ method: 'GET', boardId: ID, since: 0 }, store)
  ok(early.json.gap === true && early.json.events.length === EVENTS_MAX,
    'a poll older than the retained ring reads everything back with gap:true')
  const late = await handle({ method: 'GET', boardId: ID, since: ring[ring.length - 1].seq - 5 }, store)
  ok(late.json.gap === undefined && late.json.events.length === 5,
    'a poll within the retained ring reads only the newer events, no gap')
}

// --- the message queue -------------------------------------------------------

const postMsg = (store, nonce, msg, extra = {}) => post(store, {
  body: { kind: 'msg', nonce, msg, ...extra },
})

{
  const store = fakeStore()
  const badNonce = await postMsg(store, 'bad nonce!', { type: 'select', id: 'x' })
  ok(badNonce.status === 400, 'a nonce that is not nonceOk-shaped is refused')
  const noMsg = await postMsg(store, 'n1', 'not-an-object')
  ok(noMsg.status === 400, 'a msg that is not an object is refused')
  const noType = await postMsg(store, 'n1', { id: 'x' })
  ok(noType.status === 400, 'a msg without a type is refused')
  const badType = await postMsg(store, 'n1', { type: '9bad' })
  ok(badType.status === 400, 'a msg type that is not typeOk-shaped is refused')
  const huge = await postMsg(store, 'n1', { type: 'send', text: 'x'.repeat(MSG_MAX_BYTES) })
  ok(huge.status === 413, 'a msg whose JSON exceeds msgMaxBytes is refused 413')
  ok(store.map.size === 0, '…and none of the shape rejects stored anything')
}

{
  const store = fakeStore()
  const r = await postMsg(store, 'n1', { type: 'select', id: 'abc' })
  ok(r.status === 200 && r.json.ok === true, 'a valid msg is queued')
  const q = JSON.parse(store.map.get(`q:${ID}`))
  ok(q.length === 1 && q[0].nonce === 'n1' && q[0].msg.type === 'select', 'the queue holds { nonce, at, msg }')
  const again = await postMsg(store, 'n1', { type: 'select', id: 'abc' })
  ok(again.status === 200 && JSON.parse(store.map.get(`q:${ID}`)).length === 1,
    'the same nonce twice is an idempotent retry, not a duplicate')

  for (let i = 0; i < MSG_MAX - 1; i++) await postMsg(store, `fill${i}`, { type: 'note', i })
  ok(JSON.parse(store.map.get(`q:${ID}`)).length === MSG_MAX, 'the queue is full at msgMax')
  const over = await postMsg(store, 'over', { type: 'note' })
  ok(over.status === 429 && over.json.error.includes('full'),
    'one more is refused 429 — a holder of the id cannot bloat the store')
}

{
  const store = fakeStore()
  await postMsg(store, 'n1', { type: 'select', id: 'abc' })
  await postMsg(store, 'n2', { type: 'select', id: 'def' })
  const ack = await post(store, { body: { kind: 'ack', nonces: ['n1', 'n9'] } })
  ok(ack.status === 200, 'an ack is accepted — unknown nonces in it are nothing to remove')
  const q = JSON.parse(store.map.get(`q:${ID}`))
  ok(q.length === 1 && q[0].nonce === 'n2', 'acked messages leave the queue; the rest stay')
  const badAck = await post(store, { body: { kind: 'ack', nonces: ['bad nonce'] } })
  ok(badAck.status === 400, 'a malformed ack is refused')
  await post(store, { body: { kind: 'ack', nonces: ['n2'] } })
  ok(store.map.get(`q:${ID}`) === undefined, 'an empty queue is deleted, not stored as []')
}

// --- GET semantics -----------------------------------------------------------

{
  const store = fakeStore()
  const empty = await handle({ method: 'GET', boardId: ID }, store)
  ok(empty.status === 404 && empty.json.error.includes('first push'),
    'a board no one pushed to yet reads as 404, not an empty board')

  await post(store, { body: frameBody() })
  store.reads.length = 0

  const got = await handle({ method: 'GET', boardId: ID }, store)
  ok(got.status === 200 && got.json.frame && got.json.frame.type === 'state' && got.json.events.length === 0,
    'a first load returns the latest frame and no events')
  ok(got.json.seq === 1 && got.json.at === 1000, '…with the clock’s seq and at')

  // The cheap poll: an unchanged seq answers WITHOUT reading the frame blob.
  store.reads.length = 0 // the first load above legitimately read the frame; watch only the cheap poll
  const cheap = await handle({ method: 'GET', boardId: ID, since: 1 }, store)
  ok(cheap.status === 200 && cheap.json.frame === undefined && cheap.json.events.length === 0,
    'an unchanged seq is a cheap poll: no frame, no events')
  ok(!store.reads.includes(`f:${ID}`), '…and it never read the frame blob')

  // A frame is included only when it is newer than the cursor.
  const newer = await handle({ method: 'GET', boardId: ID, since: 0 }, store)
  ok(newer.json.frame && newer.json.frame.type === 'state', 'a frame newer than the cursor rides along')
}

{
  // The frame is replaced, never merged; models ride only when present.
  const store = fakeStore()
  await post(store, { body: frameBody({ state: { ready: true, v: 1 }, models: [{ id: 'm1', label: 'M1' }] }) })
  await post(store, { body: frameBody({ at: 2000, state: { ready: true, v: 2 } }) })
  const f = JSON.parse(store.map.get(`f:${ID}`))
  ok(f.seq === 2 && f.frame.state.v === 2 && f.frame.state.v1 === undefined,
    'the second frame replaces the first — nothing of the old state survives')
  const m = JSON.parse(store.map.get(`m:${ID}`))
  ok(m.models.length === 1, 'a frame without models leaves the catalogue alone')
}

{
  // viewerAt is throttled to one clock write per 20 s.
  const store = fakeStore()
  await post(store, { body: frameBody() })
  store.writes.length = 0
  await handle({ method: 'GET', boardId: ID, since: 1 }, store)
  const first = store.writes.filter((k) => k === `s:${ID}`).length
  await handle({ method: 'GET', boardId: ID, since: 1 }, store)
  const second = store.writes.filter((k) => k === `s:${ID}`).length
  ok(first === 1 && second === 1, 'a viewer is recorded once per 20 s, not once per poll')
}

{
  // models=1 and msgs=1 are dedicated reads.
  const store = fakeStore()
  const noModels = await handle({ method: 'GET', boardId: ID, models: true }, store)
  ok(noModels.status === 404, '?models=1 is 404 before any catalogue has been pushed')
  await post(store, { body: frameBody({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] }) })
  const models = await handle({ method: 'GET', boardId: ID, models: true }, store)
  ok(models.status === 200 && models.json.mv === 'v1' && models.json.models[0].label === 'Opus 5',
    '?models=1 reads the catalogue and its mv')

  await postMsg(store, 'n1', { type: 'select', id: 'abc' })
  const msgs = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(msgs.status === 200 && msgs.json.msgs.length === 1 && msgs.json.msgs[0].nonce === 'n1',
    '?msgs=1 reads the pending queue')
  ok(typeof msgs.json.viewerAt === 'number', '…with the last-viewed time')
}

{
  // A push answer carries the pending queue, so a busy board picks messages up
  // on its own pushes; only an ack removes them.
  const store = fakeStore()
  await post(store, { body: frameBody() })
  await postMsg(store, 'n1', { type: 'select', id: 'abc' })
  const r = await post(store, { body: frameBody({ at: 2000 }) })
  ok(Array.isArray(r.json.msgs) && r.json.msgs.length === 1 && r.json.msgs[0].nonce === 'n1',
    'a frame answer carries the pending messages')
  ok(JSON.parse(store.map.get(`q:${ID}`)).length === 1, 'delivery does not remove — only an ack does')
}

// --- the constants agree with the contract -----------------------------------

{
  ok(ID_OK.source === '^[0-9a-f]{24}$', 'ID_OK is the 24-hex board-address rule')
  ok(NONCE_OK.source === '^[A-Za-z0-9._-]{1,64}$', 'NONCE_OK is the ack-handle rule')
  ok(TYPE_OK.source === '^[A-Za-z][A-Za-z0-9._-]{0,39}$', 'TYPE_OK is the message-type rule')
  ok(MSG_MAX === 40 && MSG_MAX_BYTES === 4_000_000 && FRAME_MAX_BYTES === 4_000_000 && EVENTS_MAX === 50,
    'the bounds are the literal numbers the contract carries')
}

console.log(fails ? `\n${fails} failure(s)` : '\nrelay handler: all ok')
process.exit(fails ? 1 : 0)
