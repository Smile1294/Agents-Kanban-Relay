/* The plain-Node host, exercised for real: server.js is spawned as a
 * child process on an ephemeral port with a throwaway data directory, and the
 * relay contract — update/read/command/ack round-trips, the static page, the
 * body cap, persistence across a restart — is driven over real HTTP.
 *
 * This is the deployable the howToTest rides on, so it is the host that gets
 * the whole round trip rather than the injected store.
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
const index = (at) => ({
  v: 1, at, writes: false,
  columns: [{ id: 'backlog', name: 'Backlog' }],
  sessions: { abc: { key: 'abc', title: 'Fix it', phase: 'backlog', tags: [], archived: false, updated: at, tv: 1 } },
})
const update = (at) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-rc-key': ID },
  body: JSON.stringify({ kind: 'update', index: index(at), tails: [] }),
})

const tmp = await mkdtemp(join(tmpdir(), 'rc-relay-'))
const s1 = await startServer(tmp)

// --- static page and routing --------------------------------------------------

{
  const home = await fetch(s1.base + '/')
  ok(home.status === 200 && (await home.text()).includes('Remote board'),
    'the site root serves the viewer page')
  const css = await fetch(s1.base + '/board.css')
  ok(css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'),
    'board.css serves with a css content type')
  const js = await fetch(s1.base + '/board.js')
  ok(js.status === 200 && (await js.text()).includes('sendCommand'),
    'board.js serves, and carries the write-channel composer')
  const miss = await fetch(s1.base + '/board.css/../server.js')
  ok(miss.status === 404, 'a path that is not on the whitelist is 404, never a file')
}

// --- the relay round trip -----------------------------------------------------

{
  const before = await fetch(s1.base + '/board?id=' + ID)
  ok(before.status === 404, 'no board yet: the first push has not happened')
  const pushed = await fetch(s1.base + '/board', update(1000))
  ok(pushed.status === 200 && (await pushed.json()).ok === true, 'an update is accepted')
  const got = await fetch(s1.base + '/board?id=' + ID)
  ok(got.status === 200 && (await got.json()).index.sessions.abc.title === 'Fix it',
    'the index reads back over HTTP')
  const noKey = await fetch(s1.base + '/board?id=' + ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'update', index: index(2000), tails: [] }),
  })
  ok(noKey.status === 401, 'a POST without the board key is refused — the write gate holds over HTTP')
}

// --- the command channel, end to end ------------------------------------------

{
  const post = (body) => fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': ID },
    body: JSON.stringify(body),
  })
  const queued = await post({ kind: 'command', nonce: 'n1', text: 'fix the build', session: 'abc' })
  ok(queued.status === 200, 'a command is queued')
  const poll = await fetch(s1.base + '/board?id=' + ID + '&cmds=1')
  const { cmds } = await poll.json()
  ok(Array.isArray(cmds) && cmds.length === 1 && cmds[0].nonce === 'n1' && cmds[0].session === 'abc',
    'the command reads back on the dedicated poll')
  const acked = await post({ kind: 'ack', nonces: ['n1'] })
  ok(acked.status === 200, 'the ack is accepted')
  const after = await fetch(s1.base + '/board?id=' + ID + '&cmds=1')
  ok((await after.json()).cmds.length === 0, '…and the queue is empty after it')
}

// --- the body cap -------------------------------------------------------------

{
  const big = await fetch(s1.base + '/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc-key': ID },
    body: 'x'.repeat(1024 * 1024 + 1),
  })
  ok(big.status === 413, 'a body past the cap is refused 413, not buffered')
}

// --- persistence across a restart ---------------------------------------------

await stop(s1.child)
const s2 = await startServer(tmp)
{
  const got = await fetch(s2.base + '/board?id=' + ID)
  ok(got.status === 200 && (await got.json()).index.sessions.abc.title === 'Fix it',
    'the board survives a restart — the store is a file, not memory')
}
await stop(s2.child)
await rm(tmp, { recursive: true, force: true })

console.log(fails ? `\n${fails} failure(s)` : '\nnode relay server: all ok')
process.exit(fails ? 1 : 0)
