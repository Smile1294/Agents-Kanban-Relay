/* The relay's logic, exercised in its own repository against a fake store.
 *
 * Contract v2: the relay carries the extension's OWN board webview — the frame
 * (`{ type:'state', state }`), the model catalogue, the host→page event ring,
 * and the page→host message queue. This file pins the write gate, the storage
 * names, the monotonic clock, the frame's replace-not-merge, the event ring's
 * retention, the message queue's validation, and every GET shape.
 */
import { handle, composePatch, ID_OK, NONCE_OK, TYPE_OK, MSG_MAX, MSG_MAX_BYTES, FRAME_MAX_BYTES, EVENTS_MAX, DELTAS_MAX } from '../functions/board-core.mjs'

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

// --- the event ring is bounded in BYTES, not only in entries -----------------
//
// `eventsMax` alone bounds the COUNT: fifty entries of any size each, in a blob
// every board GET reads back. Today's extension stays far inside that — search
// caps at 200 hits with a 340-character snippet — so nothing has hit it; the
// rule was simply missing, while a frame and a message each had one. The rule
// is the frame's: the frame is the largest thing this relay stores for a
// board, so the event ring may not exceed what one frame may.

{
  const store = fakeStore()
  const huge = { kind: 'event', events: [{ type: 'searchResults', blob: 'x'.repeat(FRAME_MAX_BYTES) }] }
  const tooBig = await post(store, { body: huge })
  ok(tooBig.status === 413, 'an events POST larger than a frame may be is refused')
  ok(store.map.get(`e:${ID}`) === undefined, '…and nothing was stored')
}

{
  const store = fakeStore()
  // Five events, each a fifth of the ceiling: under the count limit the whole
  // way, over the byte ceiling by the fourth.
  const chunk = 'y'.repeat(Math.floor(FRAME_MAX_BYTES / 5))
  for (let i = 0; i < 5; i++) {
    const r = await post(store, { body: { kind: 'event', events: [{ type: 'searchResults', i, chunk }] } })
    ok(r.status === 200, `event ${i} is accepted on its own — each is well under the ceiling`)
  }
  const text = store.map.get(`e:${ID}`)
  const ring = JSON.parse(text)
  ok(text.length <= FRAME_MAX_BYTES,
    `the stored ring is within the ceiling (${text.length} <= ${FRAME_MAX_BYTES})`)
  ok(ring.length < 5 && ring.length >= 1, `and it evicted to get there (${ring.length} of 5 kept)`)
  ok(ring[ring.length - 1].msg.i === 4, 'the NEWEST is what is kept — an evicting ring drops the oldest')
  const early = await handle({ method: 'GET', boardId: ID, since: 0 }, store)
  ok(early.json.gap === true,
    'a reader older than what survived is told gap:true — the same path a slow poller already takes')
}

{
  // The eviction loop keeps one entry whatever its size, and that arm is not
  // reachable from outside — which is the POINT, and is the thing to pin.
  // An accepted event ALWAYS fits the ring on its own, because the POST guard
  // measures a strictly larger string: `{"kind":"event","events":[X]}` wraps X
  // in more characters than `{"seq":n,"msg":X}` does. So the ceiling can never
  // answer `ok` to an event and then store nothing — the two rules cannot
  // invert. If someone widens the POST guard past the ring ceiling, this is
  // what says so.
  const store = fakeStore()
  const big = 'w'.repeat(FRAME_MAX_BYTES - 100)
  const body = { kind: 'event', events: [{ type: 'searchResults', big }] }
  ok(JSON.stringify(body).length <= FRAME_MAX_BYTES, 'the largest event the POST guard admits, admitted')
  const r = await post(store, { body })
  ok(r.status === 200, '…posts')
  const text = store.map.get(`e:${ID}`)
  const ring = JSON.parse(text)
  ok(ring.length === 1 && ring[0].msg.type === 'searchResults',
    'and it is stored, alone — an accepted event is never evicted to nothing')
  ok(text.length <= FRAME_MAX_BYTES,
    `and it still fits the ring ceiling, because the POST guard measures more (${text.length})`)
}

// --- the frame answer names the slots, so READING is enough to be served -----
//
// The machine learned who was watching only from `?msgs=1`, which is the WRITE
// channel and does not run while `remote.writes` is off — the default. So a
// page that only read was never discovered, no slot was ever built for it, and
// every browser fell back to the shared slot: the board could only show the
// conversation the computer had open. The list rides the frame POST too, which
// the machine makes whatever the write toggle says.

{
  const store = fakeStore()
  await post(store, { body: frameBody() })            // the machine is pushing
  // A page that has NEVER posted a message — it only reads the board.
  await handle({ method: 'GET', boardId: ID, since: 0, viewer: 'reader-1' }, store)
  const r = await post(store, { body: frameBody({ at: 1001 }) })
  ok(Array.isArray(r.json.slots), 'a frame answer carries the slot list')
  ok(r.json.slots.includes('reader-1'),
    'including a viewer that has only READ — being served must not require writing')

  // THE ARRIVAL, past a hot throttle. `clock.viewerAt` is ONE board-wide
  // timestamp, so a second page polling while the first keeps that window warm
  // was skipped — for minutes, or for as long as anyone else kept polling. The
  // machine builds a board per slot it is told about, so a page it is never
  // told about reads the shared slot for ever: the browser stuck on whatever
  // conversation the computer had open. An arrival is not a refresh.
  await handle({ method: 'GET', boardId: ID, since: 0, viewer: 'reader-1' }, store)  // keeps it hot
  const second = await handle({ method: 'GET', boardId: ID, since: 0, viewer: 'reader-2' }, store)
  ok(second.status === 200, 'a second page polls moments after the first')
  const r2 = await post(store, { body: frameBody({ at: 2000 }) })
  ok(r2.json.slots.includes('reader-2'),
    'and is registered AT ONCE, not when the board-wide throttle happens to be cold')
  ok(r2.json.slots.length === 2, 'both pages are slots, neither displacing the other')
  // NOT asserting which of the two comes first: both were seen within the same
  // millisecond, and `Date.now()` cannot order them. The list is sorted by last
  // seen, ties fall where they fall, and a test that pins a tie is testing the
  // clock's resolution rather than the code.

  const viaMsgs = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(JSON.stringify(viaMsgs.json.viewers) === JSON.stringify(r2.json.slots),
    'and it is the SAME list ?msgs=1 answers — two answers that must agree, from one place')

  // The throttle still does its job for a viewer already known: a poll from a
  // registered page must not write the clock every time.
  const before = store.writes.length
  await handle({ method: 'GET', boardId: ID, since: 0, viewer: 'reader-2' }, store)
  ok(store.writes.length === before,
    'a KNOWN viewer polling again writes nothing — the throttle is intact where it belongs')
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

// --- patch frames: the transcript travels once -------------------------------
//
// 97% of a frame is the transcript (measured: 274 KB of a 282 KB frame on a
// 400-row session) and it is almost entirely immutable, so a push may carry the
// board minus its transcript plus the rows that changed. The relay COMPOSES
// each patch onto the frame it stores as well as keeping it — that is what lets
// a page joining mid-stream, or one that has fallen past the ring, always be
// handed a whole board rather than fragments it cannot place.

const rows = (n, tail = '') => Array.from({ length: n }, (_, i) => ({ kind: 'text', text: 'row ' + i + tail }))
const chat = (n, over = {}) => ({ ready: true, mode: 'chat', selectedKey: 'a', cards: [], transcript: rows(n), ...over })
const patchBody = (base, over = {}) => ({
  kind: 'frame', at: 2000, writes: true, mv: 'v1',
  patch: { base, state: { ready: true, mode: 'chat', selectedKey: 'a', cards: [], running: 1 }, ...over },
})

{
  const store = fakeStore()
  const first = await post(store, { body: { ...frameBody(), state: chat(3) } })
  ok(first.json.patches === true, 'every frame answer says whether this relay speaks patches')
  ok(first.json.frameSeq === 1, 'and names the seq it stored the frame under — the base for the next patch')

  const applied = await handle({
    method: 'POST', boardId: ID, key: ID,
    body: patchBody(1, { rows: { from: 3, rows: [{ kind: 'text', text: 'row 3' }] } }),
  }, store)
  ok(applied.json.needFrame === undefined, 'a patch naming the held frame is accepted')
  ok(applied.json.frameSeq === 2, 'and the answer names the new base')

  const stored = JSON.parse(store.map.get(`f:${ID}`))
  ok(stored.frame.state.transcript.length === 4,
    'the relay COMPOSES the patch onto the frame it holds — 4 rows, not 1')
  ok(stored.frame.state.transcript[0].text === 'row 0' && stored.frame.state.transcript[3].text === 'row 3',
    'the rows above the splice are the ones it already had')
  ok(stored.frame.state.running === 1, 'and the rest of the board is the patch’s own')
}

{
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  const stale = await handle({ method: 'POST', boardId: ID, key: ID, body: patchBody(99) }, store)
  ok(stale.json.needFrame === true,
    'a patch naming a frame the relay is NOT holding is refused, never guessed at')
  const stored = JSON.parse(store.map.get(`f:${ID}`))
  ok(stored.frame.state.transcript.length === 3, '…and nothing is stored: the board is untouched')
  ok(stored.seq === 1, '…and seq does not move, so no watcher is told there was news')
}

{
  const store = fakeStore()
  const empty = await handle({ method: 'POST', boardId: ID, key: ID, body: patchBody(0) }, store)
  ok(empty.json.needFrame === true, 'a patch to a board with no frame at all is refused')
}

{
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  await handle({ method: 'POST', boardId: ID, key: ID,
    body: patchBody(1, { rows: { from: 3, rows: [{ kind: 'text', text: 'row 3' }] } }) }, store)
  ok(JSON.parse(store.map.get(`d:${ID}`)).length === 1, 'the patch is kept as well as composed')
  await post(store, { body: { ...frameBody(), state: chat(9) } })
  ok(store.map.get(`d:${ID}`) === undefined,
    'a whole state RESETS the ring — every retained patch describes a chain that leads nowhere')
}

{
  // A patch whose splice starts past the end of what the relay holds cannot be
  // placed: it would leave a hole in the transcript.
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  const holed = await handle({ method: 'POST', boardId: ID, key: ID,
    body: patchBody(1, { rows: { from: 8, rows: [{ kind: 'text', text: 'x' }] } }) }, store)
  ok(holed.json.needFrame === true, 'a splice that would leave a gap is refused')
}

// --- GET: patches for a caller that asked, the whole board for one that did not

{
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  await handle({ method: 'POST', boardId: ID, key: ID,
    body: patchBody(1, { rows: { from: 3, rows: [{ kind: 'text', text: 'row 3' }] } }) }, store)

  const old = await handle({ method: 'GET', boardId: ID, since: 1 }, store)
  ok(old.json.frame && !old.json.deltas,
    'a caller that did not ask for patches gets the whole composed frame — an old page is safe')
  ok(old.json.frame.state.transcript.length === 4, '…and it is the CURRENT board, composed')

  const asked = await handle({ method: 'GET', boardId: ID, since: 1, deltas: true }, store)
  ok(asked.json.deltas && asked.json.deltas.length === 1 && !asked.json.frame,
    'a caller that asked, and whose cursor the chain reaches, gets the patch alone')

  const fresh = await handle({ method: 'GET', boardId: ID, deltas: true }, store)
  ok(fresh.json.frame && !fresh.json.deltas,
    'a first load gets the whole board however it asks — there is nothing to apply a patch to')
}

{
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  // Fall further behind than the ring retains.
  for (let i = 0; i < DELTAS_MAX + 5; i++) {
    const clock = JSON.parse(store.map.get(`s:${ID}`))
    await handle({ method: 'POST', boardId: ID, key: ID,
      body: patchBody(clock.frameSeq, { rows: { from: 3 + i, rows: [{ kind: 'text', text: 'r' + i }] } }) }, store)
  }
  ok(JSON.parse(store.map.get(`d:${ID}`)).length === DELTAS_MAX, 'the ring is bounded')
  const behind = await handle({ method: 'GET', boardId: ID, since: 1, deltas: true }, store)
  ok(behind.json.frame && !behind.json.deltas,
    'a caller further behind than the ring gets the whole board, never a chain with a hole in it')
  ok(behind.json.frame.state.transcript.length === 3 + DELTAS_MAX + 5,
    '…and that board is complete, because the relay composed as it went')
}

{
  // Events bump seq too, so a caller's cursor need not equal any patch's base.
  const store = fakeStore()
  await post(store, { body: { ...frameBody(), state: chat(3) } })
  await handle({ method: 'POST', boardId: ID, key: ID,
    body: { kind: 'event', events: [{ type: 'searchResults' }] } }, store)
  const cursor = JSON.parse(store.map.get(`s:${ID}`)).seq
  await handle({ method: 'POST', boardId: ID, key: ID,
    body: patchBody(1, { rows: { from: 3, rows: [{ kind: 'text', text: 'row 3' }] } }) }, store)
  const got = await handle({ method: 'GET', boardId: ID, since: cursor, deltas: true }, store)
  ok(got.json.deltas && got.json.deltas.length === 1,
    'a cursor moved on by an EVENT still resolves to the right patch — the chain is checked by base')
}

// --- concurrent requests are serialised per board ----------------------------
//
// Every branch of `handle` is a read-modify-write across `await` points, so a
// host that serves requests concurrently interleaves them: two requests read
// the same `seq`, both write `seq + 1`, and one increment is gone. The clock is
// the one number both ends agree on — a frame filed under a seq a watching page
// has already passed is a frame that page never sees.

{
  const store = fakeStore()
  // A store whose writes actually take time, and which counts overlaps: an
  // instantaneous fake would pass with or without the mutex.
  let inFlight = 0
  let maxOverlap = 0
  const slow = {
    ...store,
    async set(k, v) {
      inFlight++
      maxOverlap = Math.max(maxOverlap, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return store.set(k, v)
    },
  }
  await post(slow)
  await Promise.all(Array.from({ length: 50 }, (_, i) => handle({
    method: 'POST', boardId: ID, key: ID,
    body: { kind: 'event', events: [{ type: 'searchResults', n: i }] },
  }, slow)))
  const clock = JSON.parse(store.map.get(`s:${ID}`))
  ok(clock.seq === 51, `50 concurrent events after one frame leave seq at 51 (got ${clock.seq})`)
  ok(maxOverlap === 1, `one board's writes never overlap (max overlap ${maxOverlap})`)
}

{
  const store = fakeStore()
  await post(store)
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => handle({
    method: 'POST', boardId: ID, key: ID, body: { kind: 'msg', nonce: 'n' + i, msg: { type: 'select' } },
  }, store)))
  const accepted = results.filter((r) => r.status === 200).length
  const queued = JSON.parse(store.map.get(`q:${ID}`)).length
  ok(queued === accepted,
    `every message answered 200 is IN the queue (${accepted} accepted, ${queued} queued)`)
  ok(queued === MSG_MAX, 'and the cap is the cap, not "whichever write won"')
}

{
  // A store that throws must not wedge the board: the chain runs the next
  // request whether the previous one resolved or threw.
  const store = fakeStore()
  await post(store)
  let boom = true
  const flaky = { ...store, async set(k, v) { if (boom) { boom = false; throw new Error('disk') } return store.set(k, v) } }
  const threw = await handle({
    method: 'POST', boardId: ID, key: ID, body: { kind: 'event', events: [{ type: 'x' }] },
  }, flaky).then(() => null, (e) => e)
  ok(threw instanceof Error, 'a store failure still surfaces to the host')
  const after = await handle({
    method: 'POST', boardId: ID, key: ID, body: { kind: 'event', events: [{ type: 'y' }] },
  }, flaky)
  ok(after.status === 200, '…and the board keeps serving: one failed write does not wedge the chain')
}

{
  // Per BOARD, not global — one board's slow write must not hold another's poll.
  const store = fakeStore()
  const order = []
  const slow = {
    ...store,
    async set(k, v) {
      // Only the first board's writes are slow.
      if (k.endsWith(ID)) await new Promise((r) => setTimeout(r, 20))
      order.push(k)
      return store.set(k, v)
    },
  }
  const OTHER = 'c'.repeat(24)
  const a = handle({ method: 'POST', boardId: ID, key: ID, body: frameBody() }, slow)
  const b = handle({ method: 'POST', boardId: OTHER, key: OTHER, body: frameBody() }, slow)
  await Promise.all([a, b])
  ok(order[0].endsWith(OTHER),
    'a fast board answers while a slow one is still writing — the lock is per board')
}

// --- a frame slot per viewer -------------------------------------------------
//
// A board is one board; the conversation open on it is not. Two phones used to
// share one frame slot, so whichever tapped last decided what both of them saw
// and the other sat on "Loading this conversation…" for a conversation that was
// never going to arrive.

const V1 = 'viewer-one'
const V2 = 'viewer-two'
const getFor = (store, over = {}) => handle({ method: 'GET', boardId: ID, ...over }, store)
const chatFor = (key) => ({ ready: true, mode: 'chat', selectedKey: key, cards: [], transcript: [] })

{
  const store = fakeStore()
  await post(store, { body: frameBody({ viewer: V1, state: chatFor('alpha') }) })
  await post(store, { body: frameBody({ viewer: V2, state: chatFor('beta') }) })

  const one = await getFor(store, { viewer: V1 })
  const two = await getFor(store, { viewer: V2 })
  ok(one.json.frame.state.selectedKey === 'alpha',
    'each viewer reads its OWN frame — one page is on alpha')
  ok(two.json.frame.state.selectedKey === 'beta',
    '…and the other on beta, at the same time, on the same board')

  const anon = await getFor(store, {})
  ok(anon.json.frame === null,
    'a page with no viewer id reads the SHARED slot, which nobody has written')

  await post(store, { body: frameBody({ state: chatFor('shared') }) })
  const nowAnon = await getFor(store, {})
  ok(nowAnon.json.frame.state.selectedKey === 'shared',
    '…and gets it once something writes there — a v3 extension keeps working')
  const three = await getFor(store, { viewer: 'viewer-three' })
  ok(three.json.frame.state.selectedKey === 'shared',
    'a viewer nobody has pushed to yet FALLS BACK to the shared slot rather than seeing nothing')
}

{
  // A patch is placed against the slot's own seq, not the board's last write.
  const store = fakeStore()
  const first = await post(store, { body: frameBody({ viewer: V1, state: chat(10) }) })
  const base = first.json.frameSeq
  ok(first.json.viewers === true,
    'the relay SAYS it keeps a slot per viewer — a pusher never assumes it')
  // Another viewer writes in between, which advances the board clock.
  await post(store, { body: frameBody({ viewer: V2, state: chat(3) }) })
  const patched = await post(store, {
    body: {
      ...patchBody(base, { rows: { from: 10, rows: [{ kind: 'text', text: 'row 10' }] } }),
      viewer: V1,
    },
  })
  ok(!patched.json.needFrame,
    "another page's push does not invalidate this one's patch base")
  const after = await getFor(store, { viewer: V1 })
  ok(after.json.frame.state.transcript.length === 11,
    '…and the patch composed onto the right conversation')
  const other = await getFor(store, { viewer: V2 })
  ok(other.json.frame.state.transcript.length === 3,
    'while the other viewer’s board is untouched by it')
}

{
  // The slots are BOUNDED: a page that opens once and never returns must not
  // cost this relay a whole board for ever.
  const store = fakeStore()
  for (let i = 0; i < 6; i++) {
    await post(store, { body: frameBody({ at: 1000 + i, viewer: `v-${i}`, state: chatFor(`s-${i}`) }) })
  }
  const oldest = await getFor(store, { viewer: 'v-0' })
  ok(oldest.json.frame === null,
    'the least recently seen slot is evicted — five viewers, four slots, and no shared frame to fall back to')
  const newest = await getFor(store, { viewer: 'v-5' })
  ok(newest.json.frame.state.selectedKey === 's-5', 'while the most recent is still there')
  const msgs = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(msgs.json.viewers.length === 4 && msgs.json.viewers[0] === 'v-5',
    'and the queue read NAMES the surviving slots, most recent first, so the machine knows who to build for')
}

{
  /* A viewer id is a NAME, and one name is not like the others. `viewers[k] = n`
     on an ordinary object silently does nothing when k is `__proto__`, so that
     slot would be untracked, never evicted, and its frame left behind for ever.
     The clock's map is JSON off a store — another program's output — so it is
     rebuilt with a null prototype rather than written in place. */
  const store = fakeStore()
  /* Times ASCENDING and pushes only — a board GET registers the viewer with the
     wall clock, which would make whichever slot was read the most recent one and
     turn this into a test of the harness. */
  const t0 = Date.now()
  await post(store, { body: frameBody({ at: t0, viewer: '__proto__', state: chatFor('odd') }) })
  const listed = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(listed.json.viewers.includes('__proto__'),
    'a slot named `__proto__` is TRACKED, so the eviction that bounds these slots can reach it')
  const held = await getFor(store, { viewer: '__proto__' })
  ok(held.json.frame.state.selectedKey === 'odd', 'and it holds its own frame like any other')
  for (let i = 0; i < 4; i++) {
    await post(store, { body: frameBody({ at: Date.now() + 1 + i, viewer: `later-${i}`, state: chatFor(`s-${i}`) }) })
  }
  const clock = JSON.parse(store.map.get(`s:${ID}`))
  ok(!Object.keys(clock.viewers).includes('__proto__'),
    'and it is evicted when four newer pages arrive, rather than leaking a frame nobody can reach')
  ok(![...store.map.keys()].some((k) => k.endsWith(':__proto__')),
    '…blob and patch ring with it')
}

{
  // A message says WHO asked, so a select from one phone does not move the
  // other one's board.
  const store = fakeStore()
  await post(store, { body: frameBody() })
  await postMsg(store, 'n1', { type: 'select', id: 'alpha' }, { viewer: V1 })
  const msgs = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(msgs.json.msgs[0].viewer === V1, 'a queued message carries the viewer that sent it')
  await postMsg(store, 'n2', { type: 'select', id: 'beta' })
  const both = await handle({ method: 'GET', boardId: ID, msgs: true }, store)
  ok(both.json.msgs[1].viewer === undefined,
    '…and one from a page with no id carries none, rather than being refused')
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
