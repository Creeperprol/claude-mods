import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'))
const SERVER = new URL('./server.mjs', import.meta.url).pathname

// A tiny MCP client over stdio.
const start = (cli, name) => {
  const p = spawn('node', [SERVER], { env: { ...process.env, LINK_HOME: HOME, LINK_CLI: cli, LINK_NAME: name }, stdio: ['pipe', 'pipe', 'inherit'] })
  let n = 0
  const waiting = new Map()
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', c => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiting.get(m.id)?.(m)
    }
  })
  const rpc = (method, params) =>
    new Promise(res => {
      const id = ++n
      waiting.set(id, res)
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    init: () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }),
    list: () => rpc('tools/list', {}),
    tool: async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args })
      return { text: r.result.content[0].text, isError: !!r.result.isError }
    },
    stop: () => p.stdin.end(),
  }
}

test('sessions of different CLIs find each other, hand out work and report back', async () => {
  const host = start('claude', 'boss')
  const codex = start('codex', 'coder')
  const qwen = start('qwen', 'quinn')
  for (const s of [host, codex, qwen]) {
    const r = await s.init()
    assert.equal(r.result.serverInfo.name, 'link-bridge')
    assert.equal((await s.list()).result.tools.length, 9)
  }
  await new Promise(r => setTimeout(r, 300))

  const seen = await host.tool('link_peers')
  assert.match(seen.text, /coder\s+\[codex\]/)
  assert.match(seen.text, /quinn\s+\[qwen\]/)

  // plain message
  assert.match((await host.tool('link_tell', { to: 'cod', text: 'hello there' })).text, /Sent to coder/)
  assert.match((await codex.tool('link_inbox')).text, /MESSAGE from "boss":\nhello there/)
  assert.match((await codex.tool('link_inbox')).text, /empty/)

  // only the host may assign
  assert.equal((await codex.tool('link_assign', { worker: 'all', task: 'x' })).isError, true)
  assert.match((await host.tool('link_host')).text, /boss is the host/)
  assert.equal((await qwen.tool('link_host')).isError, true)

  const out = (await host.tool('link_assign', { worker: 'all', task: 'say hi' })).text
  assert.match(out, /coder/)
  assert.match(out, /quinn/)

  const task = (await codex.tool('link_inbox')).text
  const id = /TASK (t\w+) from host "boss"/.exec(task)[1]
  assert.match((await codex.tool('link_report', { task_id: id, result: 'Hi from codex' })).text, /sent to the host/)

  const board = (await host.tool('link_board')).text
  assert.match(board, /✓ .*coder: say hi\n\s+⇒ Hi from codex/)
  assert.match(board, /… .*quinn: say hi/)
  assert.match((await host.tool('link_inbox')).text, /RESULT .* from "coder":\nHi from codex/)

  assert.match((await host.tool('link_board', { clear: true })).text, /Cleared 1/)

  // a worker can not report a task it was never given
  assert.equal((await qwen.tool('link_report', { task_id: 'nope', result: 'x' })).isError, true)

  // the host renames a worker; the worker applies it itself
  await host.tool('link_rename', { worker: 'quinn', name: 'helper <b>one</b>' })
  await qwen.tool('link_peers') // any call applies pending renames
  assert.match((await host.tool('link_peers')).text, /helper one\s+\[qwen\]/)

  // waiting for an inbox returns as soon as something arrives
  const waiter = codex.tool('link_inbox', { wait_seconds: 5 })
  setTimeout(() => host.tool('link_tell', { to: 'coder', text: 'late news' }), 500)
  assert.match((await waiter).text, /late news/)

  // a stopped session leaves the list
  qwen.stop()
  await new Promise(r => setTimeout(r, 400))
  assert.doesNotMatch((await host.tool('link_peers')).text, /helper one/)

  host.stop()
  codex.stop()
})
