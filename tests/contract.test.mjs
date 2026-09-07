/* The shared contract between this repository and the extension repo.
 *
 * remote-contract.json at the repo root is carried VERBATIM in the extension
 * repo (Agents-Kanban, a sibling of this one), and the extension's verify gate
 * (`scripts/check-contract.mjs` over there) compares the two copies and
 * checks the extension's own duplicated constants — KEY_OK in relay.ts,
 * NONCE_OK and CMD_TEXT_MAX in commands.ts, the /board path in pusher.ts —
 * against the file. A rule that changed on one side without the file goes red
 * on the other side's gate.
 *
 * This test checks the RELAY side of the same file: board-core's constants
 * (the file they are enforced by), and the fnPath route each host serves.
 * board-core does not route — the hosts do — so the route literal is asserted
 * in each host's own words rather than imported.
 */
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { ID_OK, KEY_OK, NONCE_OK, SETTING_OK, THINKING_OK, CMD_MAX, CMD_TEXT_MAX } from '../functions/board-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(await fs.readFile(path.join(HERE, '..', 'remote-contract.json'), 'utf8'))

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

ok(CONTRACT.version === 1, 'the contract has a version, so a future one is not read as this one')
ok(typeof CONTRACT.payload === 'string' && CONTRACT.payload.length > 200,
  'the payload paragraph says what the API is, in words a human can check')

// board-core is the relay's copy of every rule in the contract.
ok(ID_OK.source === CONTRACT.idOk, 'idOk is ID_OK — the 24-hex board-address rule')
ok(KEY_OK.source === CONTRACT.keyOk, 'keyOk is KEY_OK — the session-key rule')
ok(NONCE_OK.source === CONTRACT.nonceOk, 'nonceOk is NONCE_OK — the ack-handle rule')
ok(SETTING_OK.source === CONTRACT.settingOk, 'settingOk is SETTING_OK — the model/effort id rule')
ok(THINKING_OK.source === CONTRACT.thinkingOk, 'thinkingOk is THINKING_OK — the thinking mode rule')
ok(CMD_MAX === CONTRACT.cmdMax, 'cmdMax is CMD_MAX — the queue bound')
ok(CMD_TEXT_MAX === CONTRACT.cmdTextMax, 'cmdTextMax is CMD_TEXT_MAX — the per-command text cap')

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
console.log("\ncontract: this copy of remote-contract.json is what board-core enforces")
