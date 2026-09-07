/* The relay's logic, exercised in its own repository.
 *
 * The extension pushes to a Netlify function (`functions/board.mjs`) that this
 * repository does not run — but the function's LOGIC lives in
 * `functions/board-core.mjs` with the blob store injected, so it runs here
 * against a fake store. This file pins the relay's contract: the write gate,
 * the storage names, replacement-not-merge, and the garbage collection of
 * tails whose session left the board.
 *
 * The rules this file pins are the SHARED contract with the extension: the
 * extension repo carries the same constants (KEY_OK in relay.ts, NONCE_OK and
 * CMD_TEXT_MAX in commands.ts) and its `verify` gate checks them against
 * remote-contract.json, whose copy here `contract.test.mjs` checks against
 * board-core. The extension cannot import this file, so the agreement between
 * the two ends is through the contract file — never through a literal.
 */
import { handle, ID_OK, KEY_OK, NONCE_OK, SETTING_OK, THINKING_OK, CMD_MAX, CMD_TEXT_MAX } from '../functions/board-core.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** A blob store in a Map, with just enough of @netlify/blobs' surface. */
function fakeStore() {
  const m = new Map()
  return {
    map: m,
    async set(k, v) { m.set(k, v) },
    async get(k) { return m.has(k) ? m.get(k) : null },
    async delete(k) { m.delete(k) },
    async list({ prefix }) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }
    },
  }
}

const ID = 'a'.repeat(24) // any 24 hex chars: the derived board id
const index = (over = {}) => ({
  v: 1, at: 1000,
  columns: [{ id: 'backlog', name: 'Backlog' }],
  sessions: { abc: { key: 'abc', title: 'Fix it', phase: 'backlog', tags: [], archived: false, updated: 1000, tv: 1 } },
  ...over,
})
const tail = (key = 'abc', over = {}) => ({
  key, at: 1000,
  entries: [{ kind: 'prompt', at: 900, text: 'hello' }],
  ...over,
})
const post = (store, over = {}) => handle({
  method: 'POST',
  boardId: ID,
  key: ID,
  body: { kind: 'update', index: index(), tails: [] },
  ...over,
}, store)

// --- the write gate ----------------------------------------------------------

{
  const store = fakeStore()
  const missing = await post(store, { key: '' })
  ok(missing.status === 401, 'a POST without the board key is refused')
  const wrong = await post(store, { boardId: ID, key: 'b'.repeat(24) })
  ok(wrong.status === 401, 'a POST with another board’s key is refused')
  const badId = await post(store, { boardId: 'not-hex!' })
  ok(badId.status === 400, 'a board address that is not 24 hex chars is refused')
  ok(store.map.size === 0, '…and nothing was stored by any of them')
}

// --- a valid update stores index and tails under derived names --------------

{
  const store = fakeStore()
  const r = await post(store, { body: { kind: 'update', index: index(), tails: [tail()] } })
  ok(r.status === 200 && r.json.ok === true, 'a valid update is accepted')
  const keys = [...store.map.keys()].sort()
  ok(keys.join(',') === `i:${ID},t:${ID}:abc`, 'the index and tail blob names derive from the board id')
  const idx = JSON.parse(store.map.get(`i:${ID}`))
  ok(idx.v === 1 && idx.sessions.abc.title === 'Fix it', 'the stored index is the pushed index, verbatim')
  const t = JSON.parse(store.map.get(`t:${ID}:abc`))
  ok(t.key === 'abc' && t.entries[0].kind === 'prompt', 'the stored tail is the pushed tail')
}

// --- garbage: bad payloads store nothing -------------------------------------

{
  const store = fakeStore()
  const noKind = await post(store, { body: { index: index(), tails: [] } })
  ok(noKind.status === 400 && noKind.json.error.includes('update'), 'a body without kind "update" is refused')
  const badIdx = await post(store, { body: { kind: 'update', index: { v: 99 }, tails: [] } })
  ok(badIdx.status === 400, 'a malformed index is refused')
  const badKey = await post(store, {
    body: { kind: 'update', index: index({ sessions: { 'a/b': index().sessions.abc } }), tails: [] },
  })
  ok(badKey.status === 400 && badKey.json.error.includes('blob name'),
    'a session key that is not safe in a blob name is refused')
  const rogue = await post(store, { body: { kind: 'update', index: index(), tails: [tail('nope')] } })
  ok(rogue.status === 400 && rogue.json.error.includes('index does not'),
    'a tail naming a session the index does not carry is refused — the page could never reach it')
  ok(store.map.size === 0, '…and none of the rejects stored anything')
}

// --- replacement, not merge, and orphan-tail GC ------------------------------

{
  const store = fakeStore()
  await post(store, {
    body: {
      kind: 'update',
      index: index({ sessions: { abc: { ...index().sessions.abc, tv: 1 } } }),
      tails: [tail('abc')],
    },
  })
  const second = await post(store, {
    body: {
      kind: 'update',
      index: index({ at: 2000, sessions: { def: { key: 'def', title: 'New one', phase: 'backlog', tags: [], archived: false, updated: 2000, tv: 2 } } }),
      tails: [tail('def', { at: 2000 })],
    },
  })
  ok(second.status === 200, 'the second update is accepted')
  const keys = [...store.map.keys()].sort()
  ok(keys.join(',') === `i:${ID},t:${ID}:def`,
    'the board is replaced, never merged: abc is gone (tail garbage-collected), def is stored')
  const idx = JSON.parse(store.map.get(`i:${ID}`))
  ok(idx.at === 2000 && idx.sessions.def && !idx.sessions.abc, 'the index is the new one, verbatim')
}

// --- reads -------------------------------------------------------------------

{
  const store = fakeStore()
  const empty = await handle({ method: 'GET', boardId: ID }, store)
  ok(empty.status === 404 && empty.json.error.includes('first push'),
    'a board no one pushed to yet reads as "waiting for the first push", not as an empty board')
  await post(store, { body: { kind: 'update', index: index(), tails: [tail()] } })
  const got = await handle({ method: 'GET', boardId: ID }, store)
  ok(got.status === 200 && got.json.index.sessions.abc.tv === 1, 'the index reads back as stored')
  const t = await handle({ method: 'GET', boardId: ID, tailKey: 'abc' }, store)
  ok(t.status === 200 && t.json.tail.entries.length === 1, 'a tail reads back by session key')
  const none = await handle({ method: 'GET', boardId: ID, tailKey: 'zzz' }, store)
  ok(none.status === 404, 'a tail that was never pushed reads as 404')
  const badTail = await handle({ method: 'GET', boardId: ID, tailKey: 'a/b' }, store)
  ok(badTail.status === 400, 'a session key that is not safe is refused on reads too')
  const method = await handle({ method: 'DELETE', boardId: ID }, store)
  ok(method.status === 405, 'anything but GET and POST is refused')
}

// --- the two regexes agree with the contract ---------------------------------
// The extension has the same two rules (KEY_OK in src/remote/relay.ts, and the
// 24-hex board id); remote-contract.json pins the agreement, and
// contract.test.mjs checks THIS end against the file.
// A drift between the two ends would push fine and store nothing.
{
  ok(ID_OK.test('0123456789abcdef01234567') && ID_OK.test('ABCDEF'.repeat(4).toLowerCase()),
    'the id rule accepts 24 hex chars')
  ok(!ID_OK.test('x'.repeat(23)) && !ID_OK.test('x'.repeat(25)) && !ID_OK.test('zz'),
    'and refuses anything else')
  ok(KEY_OK.test('abc-1._x') && !KEY_OK.test('a/b') && !KEY_OK.test('') && !KEY_OK.test('a'.repeat(81)),
    'session keys: the same rule the extension enforces before anything is sent')
}

// --- the command queue: the write channel, relay side -------------------------

const command = (store, nonce, text, extra = {}) => post(store, {
  body: { kind: 'command', nonce, text, ...extra },
})

{
  const store = fakeStore()
  const r = await command(store, 'n1', 'fix the build', { session: 'abc' })
  ok(r.status === 400 && r.json.error.includes('no board here yet'),
    'a command naming a session is refused while no board has been pushed — the session cannot be validated')
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  const r2 = await command(store, 'n1', 'fix the build', { session: 'abc' })
  ok(r2.status === 200 && r2.json.ok === true, 'once the board exists, a command naming a real session is queued')
  const queued = JSON.parse(store.map.get(`c:${ID}`))
  ok(queued.length === 1 && queued[0].nonce === 'n1' && queued[0].text === 'fix the build' && queued[0].session === 'abc',
    'the queue holds exactly the command, under the derived cmd blob name')
  const noSession = await command(store, 'n2', 'please do a thing')
  ok(noSession.status === 200, 'a command without a session (start a new session) is queued too')
  const queued2 = JSON.parse(store.map.get(`c:${ID}`))
  ok(queued2.length === 2 && queued2[1].session === undefined, '…and it carries no session field at all')
}

{
  const store = fakeStore()
  const badNonce = await command(store, 'nope nope', 'x')
  ok(badNonce.status === 400, 'a nonce that is not ack-handle-shaped is refused')
  const noText = await command(store, 'n1', '   ')
  ok(noText.status === 400, 'a command with no text is refused')
  const huge = await command(store, 'n1', 'x'.repeat(CMD_TEXT_MAX + 1))
  ok(huge.status === 400 && huge.json.error.includes('20000'), 'text over the cap is refused, and the cap is named')
  const badSession = await command(store, 'n1', 'x', { session: 'a/b' })
  ok(badSession.status === 400 && badSession.json.error.includes('not a session'),
    'a session that is not key-shaped is refused')
  ok(store.map.size === 0, '…and none of the shape rejects stored anything')
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  const unknown = await command(store, 'n1', 'x', { session: 'zzz' })
  ok(unknown.status === 400 && unknown.json.error.includes('no such session'),
    'a command naming a session the index does not carry is refused — the page could never show it')
}

{
  const store = fakeStore()
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  await command(store, 'n1', 'go')
  const again = await command(store, 'n1', 'go')
  ok(again.status === 200 && again.json.ok === true, 'the same nonce twice is an idempotent retry, not an error')
  const queued = JSON.parse(store.map.get(`c:${ID}`))
  ok(queued.length === 1, '…and it did not queue a second copy')

  for (let i = 0; i < CMD_MAX - 1; i++) await command(store, `fill${i}`, 'x')
  ok(JSON.parse(store.map.get(`c:${ID}`)).length === CMD_MAX, 'the queue is full at CMD_MAX')
  const over = await command(store, 'over', 'x')
  ok(over.status === 429 && over.json.error.includes('queue is full'),
    'one more is refused 429 — a holder of the id cannot bloat the store')
}

{
  const store = fakeStore()
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  await command(store, 'n1', 'go')
  await command(store, 'n2', 'again')
  const ack = await post(store, { body: { kind: 'ack', nonces: ['n1', 'n9'] } })
  ok(ack.status === 200, 'an ack is accepted — unknown nonces in it are simply nothing to remove')
  const queued = JSON.parse(store.map.get(`c:${ID}`))
  ok(queued.length === 1 && queued[0].nonce === 'n2', 'acked commands leave the queue; the rest stay')
  const badAck = await post(store, { body: { kind: 'ack', nonces: ['bad nonce'] } })
  ok(badAck.status === 400, 'a malformed ack is refused')
  await post(store, { body: { kind: 'ack', nonces: ['n2'] } })
  ok(store.map.get(`c:${ID}`) === undefined, 'an empty queue is deleted, not stored as []')
}

{
  // Commands ride the update answer back: a busy board picks them up on its
  // own pushes, without an extra poll.
  const store = fakeStore()
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  await command(store, 'n1', 'go')
  const r = await post(store, { body: { kind: 'update', index: index({ at: 2000 }), tails: [] } })
  ok(Array.isArray(r.json.cmds) && r.json.cmds.length === 1 && r.json.cmds[0].nonce === 'n1',
    'a push answer carries the pending commands')
  // Delivery does not remove a command — only an ack does (at-least-once).
  await post(store, { body: { kind: 'ack', nonces: ['n1'] } })
  const empty = await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  ok(empty.json.cmds === undefined, '…and an empty queue is omitted, not sent as []')

  await command(store, 'n9', 'another one')
  const got = await handle({ method: 'GET', boardId: ID, cmds: true }, store)
  ok(got.status === 200 && Array.isArray(got.json.cmds) && got.json.cmds.length === 1
      && got.json.cmds[0].nonce === 'n9',
    '?cmds=1 reads the queue directly — the host’s dedicated poll')
  const plain = await handle({ method: 'GET', boardId: ID }, store)
  ok(plain.json.cmds === undefined && plain.json.index !== undefined,
    'a GET without cmds reads the index, not the queue')
  const wrongKey = await handle({
    method: 'POST', boardId: ID, key: 'b'.repeat(24),
    body: { kind: 'ack', nonces: ['n1'] },
  }, store)
  ok(wrongKey.status === 401, 'acking needs the board’s own key too — the write gate covers every POST')
}

// --- the write-channel rules agree with the extension's, through the contract
// The extension's copy lives in src/remote/commands.ts; this file cannot
// import it (it runs as plain .mjs). The agreement is remote-contract.json,
// checked against commands.ts by the extension's verify gate and against
// board-core here by contract.test.mjs.
{
  ok(NONCE_OK.source === '^[A-Za-z0-9._-]{1,64}$', 'NONCE_OK is the literal both ends carry')
  ok(CMD_MAX === 20 && CMD_TEXT_MAX === 20_000, 'the queue bounds are the literal numbers both ends carry')
}

// --- model / effort / thinking ride a command, validated for shape only ------
{
  const store = fakeStore()
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  const r = await command(store, 'n1', 'go', { model: 'claude-opus-5', effort: 'high', thinking: 'disabled' })
  ok(r.status === 200, 'a command with model, effort and thinking is queued')
  const queued = JSON.parse(store.map.get(`c:${ID}`))
  ok(queued[0].model === 'claude-opus-5' && queued[0].effort === 'high' && queued[0].thinking === 'disabled',
    '…and the queue holds all three, verbatim')
  const plain = await command(store, 'n2', 'go')
  ok(plain.status === 200 && JSON.parse(store.map.get(`c:${ID}`))[1].model === undefined,
    'a command without them carries none of the three fields at all')
}

{
  const store = fakeStore()
  await post(store, { body: { kind: 'update', index: index(), tails: [] } })
  const badModel = await command(store, 'n1', 'x', { model: 'provider:/secret' })
  ok(badModel.status === 400 && badModel.json.error.includes('model id'),
    'a model id that is not settingOk-shaped is refused')
  const badEffort = await command(store, 'n1', 'x', { effort: 'a b' })
  ok(badEffort.status === 400 && badEffort.json.error.includes('effort'),
    'an effort that is not settingOk-shaped is refused')
  const badThinking = await command(store, 'n1', 'x', { thinking: 'maybe' })
  ok(badThinking.status === 400 && badThinking.json.error.includes('thinking'),
    'a thinking mode outside the closed set is refused')
  const badType = await command(store, 'n1', 'x', { thinking: true })
  ok(badType.status === 400, 'a boolean thinking is refused — the mode is enabled|disabled, not true|false')
  ok(store.map.get(`c:${ID}`) === undefined, '…and none of the shape rejects stored anything')
}

console.log(fails ? `\n${fails} failure(s)` : '\nrelay handler: all ok')
process.exit(fails ? 1 : 0)
