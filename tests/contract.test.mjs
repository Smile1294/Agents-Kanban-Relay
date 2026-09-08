/* The shared contract between this repository and the extension repo.
 *
 * remote-contract.json at the repo root is carried VERBATIM in the extension
 * repo (Agents-Kanban, a sibling of this one), and the extension's verify gate
 * (`scripts/check-contract.mjs` over there) compares the two copies and checks
 * the extension's own duplicated constants — NONCE_OK and TYPE_OK in
 * messages.ts, MSG_MAX_BYTES too, and FN_PATH in pusher.ts — against the file.
 * A rule that changed on one side without the file goes red on the other
 * side's gate.
 *
 * This test checks the RELAY side of the same file: board-core's constants
 * (the file they are enforced by), and the fnPath route each host serves.
 * board-core does not route — the hosts do — so the route literal is asserted
 * in each host's own words rather than imported.
 */
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import {
  ID_OK, NONCE_OK, TYPE_OK, MSG_MAX, MSG_MAX_BYTES, FRAME_MAX_BYTES, EVENTS_MAX, FN_PATH,
} from '../functions/board-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(await fs.readFile(path.join(HERE, '..', 'remote-contract.json'), 'utf8'))

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

ok(CONTRACT.version === 2, 'the contract is v2 — this is the board-webview contract, not v1')
ok(typeof CONTRACT.payload === 'string' && CONTRACT.payload.length > 200,
  'the payload paragraph says what the API is, in words a human can check')

// board-core is the relay's copy of every rule in the contract.
ok(ID_OK.source === CONTRACT.idOk, 'idOk is ID_OK — the 24-hex board-address rule')
ok(NONCE_OK.source === CONTRACT.nonceOk, 'nonceOk is NONCE_OK — the ack-handle rule')
ok(TYPE_OK.source === CONTRACT.typeOk, 'typeOk is TYPE_OK — the message-type rule')
ok(MSG_MAX === CONTRACT.msgMax, 'msgMax is MSG_MAX — the queue bound')
ok(MSG_MAX_BYTES === CONTRACT.msgMaxBytes, 'msgMaxBytes is MSG_MAX_BYTES — the per-message JSON cap')
ok(FRAME_MAX_BYTES === CONTRACT.frameMaxBytes, 'frameMaxBytes is FRAME_MAX_BYTES — the per-frame JSON cap')
ok(EVENTS_MAX === CONTRACT.eventsMax, 'eventsMax is EVENTS_MAX — the event-ring bound')
ok(FN_PATH === CONTRACT.fnPath, 'fnPath is FN_PATH — the one API path every host serves')

// The route path: fnPath is what the extension pushes to and the page fetches.
const worker = await fs.readFile(path.join(HERE, '..', 'worker.js'), 'utf8')
ok(worker.includes(`pathname !== '${CONTRACT.fnPath}'`),
  `worker.js answers only fnPath (${CONTRACT.fnPath})`)
const server = await fs.readFile(path.join(HERE, '..', 'server.js'), 'utf8')
ok(server.includes(`url.pathname === '${CONTRACT.fnPath}'`),
  `server.js routes fnPath (${CONTRACT.fnPath})`)
const netlify = await fs.readFile(path.join(HERE, '..', 'netlify.toml'), 'utf8')
ok(netlify.includes(`from = "${CONTRACT.fnPath}"`),
  `netlify.toml rewrites fnPath (${CONTRACT.fnPath})`)

if (fails) {
  console.error(`\n${fails} contract failure(s)`)
  process.exit(1)
}
console.log('\ncontract: this copy of remote-contract.json is what board-core enforces')
