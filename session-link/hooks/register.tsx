import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Inbox, Me, Msg, Role, Task } from '../types'

const PANE = 'session-link'
const log = atom({ plugin: 'session-link', key: 'log' } as const, [])
const me = atom({ plugin: 'session-link', key: 'me' } as const, null)
const role = atom({ plugin: 'session-link', key: 'role' } as const, 'solo')
const tasks = atom({ plugin: 'session-link', key: 'tasks' } as const, [])
const inbox = atom({ plugin: 'session-link', key: 'inbox' } as const, [])
const target = atom({ plugin: 'session-link', key: 'target' } as const, 'all')

const T_ASSIGN = 'mcp__session-link__assign'
const T_REPORT = 'mcp__session-link__report'
const T_PEERS = 'mcp__session-link__peers'
const T_RENAME = 'mcp__session-link__rename'

type Peer = { id: string; name: string; cwd: string; seen: number }

const FRESH_MS = 6 * 3600 * 1000

const ago = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

const base = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? 'session'

async function listPeers($: any, selfId: string): Promise<Peer[]> {
  const now = await $.clock.now()
  const out: Peer[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('peer:')) continue
    const p = (await $.store.get(k)) as Peer | undefined
    if (p && p.id !== selfId && now - p.seen < FRESH_MS) out.push(p)
  }
  return out.sort((a, z) => z.seen - a.seen)
}

const pick = (list: Peer[], q: string) => {
  const w = q.toLowerCase()
  const exact = list.filter(p => p.name.toLowerCase() === w || p.id === q)
  if (exact.length) return exact
  return list.filter(p => p.name.toLowerCase().startsWith(w) || p.id.startsWith(q))
}

async function announce($: any, who: Me, cwd: string) {
  const peer: Peer = { id: who.id, name: who.name, cwd, seen: await $.clock.now() }
  await $.store.set(`peer:${who.id}`, peer)
}

async function remember($: any, m: Msg) {
  await update($, log, l => [...l, m].slice(-50))
  $.ui.invalidate('ui.render')
}

async function deliver($: any, who: Me, p: Peer, text: string): Promise<string | null> {
  const r = await $.session.send({ to: { sessionId: p.id }, text: `[from session "${who.name}"] ${text}` })
  if (r.isDelivered) {
    await remember($, { at: await $.clock.now(), dir: 'out', who: p.name, text })
    return null
  }
  if (/not running|gone/i.test(r.reason)) await $.store.delete(`peer:${p.id}`)
  return `${p.name}: ${r.reason}`
}

const TASK_RE = /\[TASK (\S+) host=(\S+) name="([^"]*)"\]\n([\s\S]*)$/
const RENAME_RE = /\[RENAME host=(\S+)\]\n([\s\S]*)$/
const RESULT_RE = /\[RESULT (\S+) from="([^"]*)"\]\n([\s\S]*)$/

async function hostRecord($: any): Promise<{ id: string; name: string } | null> {
  const h = (await $.store.get('host')) as { id: string; name: string } | undefined
  return h ?? null
}

// Host-ness lives in the shared host record, so it survives a reload of this module.
async function isHost($: any, who: Me | null): Promise<boolean> {
  if (!who) return false
  const h = await hostRecord($)
  return h !== null && h.id === who.id
}

// Turns host mode on or off; shared by the /host command and the pane (a plugin's own
// $.command.run does not reach its own hooks).
async function setHost($: any, who: Me, isOn: boolean) {
  await update($, role, () => (isOn ? 'host' : 'solo') as Role)
  if (isOn) {
    await $.store.set('host', { id: who.id, name: who.name })
  } else {
    const h = await hostRecord($)
    if (h && h.id === who.id) await $.store.delete('host')
  }
  $.ui.invalidate('ui.render')
}

// Names are plain text: drop any markup, such as the closing tag of the message envelope.
const cleanName = (raw: string) => raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

// Asks one worker to take a new session name.
async function renameWorker($: any, who: Me, p: Peer, name: string): Promise<string | null> {
  return deliver($, who, p, `[RENAME host=${who.id}]\n${name}`)
}

// Hands one task to one worker and logs it on the board.
async function assign($: any, who: Me, p: Peer, text: string): Promise<string | null> {
  const id = `t${((await $.clock.now()) % 46656).toString(36)}${(await read($, tasks)).length}`
  const body = `[TASK ${id} host=${who.id} name="${who.name}"]\n${text}\n\nWhen you are finished, call the tool ${T_REPORT} with task_id "${id}" and a short result.`
  const failed = await deliver($, who, p, body)
  const t: Task = { id, toId: p.id, toName: p.name, text, status: failed ? 'failed' : 'sent', at: await $.clock.now() }
  await update($, tasks, l => [...l, t].slice(-30))
  $.ui.invalidate('ui.render')
  return failed
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const name = options.name ? String(options.name) : `${base(cwd)}-${id.slice(0, 4)}`
    const who: Me = { id, name }
    await update($, me, () => who)
    await announce($, who, cwd)

    const refused: string[] = []
    for (const [name, description] of [
      ['sessions', 'List your other running Claude Code sessions'],
      ['tell', 'Message another session: /tell <name> <message>'],
      ['tellall', 'Message every other session: /tellall <message>'],
      ['link', 'Open the session link pane'],
      ['host', 'Make this session the host that hands out work: /host or /host off'],
      ['assign', 'Host: give a task to a session: /assign <name|all> <task>'],
      ['board', 'Host: show the task board'],
      ['setname', 'Host: rename another session: /setname <session> <new name>'],
    ]) {
      try {
        await $.command.register({ name, description })
      } catch (err) {
        refused.push(`/${name}`)
      }
    }
    if (refused.length) $.ui.toast(`session-link: could not register ${refused.join(', ')} (name taken)`)
    try {
    await $.tool.register({
      name: 'assign',
      description: 'Host only. Give a task to another Claude Code session (a worker) and carry on; its result comes back as a message. Use worker "all" for every worker.',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', description: 'Worker session name, or "all"' }, task: { type: 'string', description: 'What the worker should do, self-contained' } },
        required: ['worker', 'task'],
      },
    })
    await $.tool.register({
      name: 'report',
      description: 'Worker only. Send the result of a task the host assigned back to the host.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' }, result: { type: 'string', description: 'Short result or summary' } },
        required: ['task_id', 'result'],
      },
    })
    await $.tool.register({
      name: 'rename',
      description: 'Host only. Rename another Claude Code session (a worker).',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', description: 'Worker session name' }, name: { type: 'string', description: 'The new session name' } },
        required: ['worker', 'name'],
      },
    })
    await $.tool.register({ name: 'peers', description: 'List the other running Claude Code sessions you can message.' })
    } catch (err) {
      $.ui.toast('session-link: could not register its tools')
    }
    void $.ui.open({ id: PANE, title: 'Sessions' })
    return next(e)
  })

  on('command.run', { command: 'host' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (e.args.trim() === 'off') {
      await setHost($, who, false)
      return { text: 'No longer hosting.' }
    }
    await setHost($, who, true)
    return { text: `${who.name} is the host. Give work with /assign <session|all> <task>, or ask me to delegate.` }
  })

  on('command.run', { command: 'assign' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (!(await isHost($, who))) return { text: 'Run /host first to make this session the host.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    if (!target || !text) return { text: 'Usage: /assign <session name|all> <task>' }
    const list = await listPeers($, who.id)
    const chosen = target === 'all' ? list : pick(list, target)
    if (chosen.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (target !== 'all' && chosen.length > 1) return { text: `"${target}" is ambiguous: ${chosen.map(p => p.name).join(', ')}` }
    const out: string[] = []
    for (const p of chosen) {
      const f = await assign($, who, p, text)
      out.push(f ? `✗ ${f}` : `→ ${p.name}`)
    }
    return { text: out.join('\n') }
  })

  on('command.run', { command: 'setname' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (!(await isHost($, who))) return { text: 'Run /host first to make this session the host.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const name = cleanName(rest.join(' '))
    if (!target || !name) return { text: 'Usage: /setname <session> <new name>' }
    const matches = pick(await listPeers($, who.id), target)
    if (matches.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (matches.length > 1) return { text: `"${target}" is ambiguous: ${matches.map(p => p.name).join(', ')}` }
    const failed = await renameWorker($, who, matches[0], name)
    return { text: failed ? `Not renamed. ${failed}` : `Asked ${matches[0].name} to rename itself to "${name}".` }
  })

  on('command.run', { command: 'board' }, async $ => {
    const list = await read($, tasks)
    if (list.length === 0) return { text: 'No tasks yet.' }
    const icon = { sent: '…', done: '✓', failed: '✗' }
    return {
      text: list
        .map(t => `${icon[t.status]} ${t.id}  ${t.toName}: ${t.text.slice(0, 60)}${t.result ? `\n    ⇒ ${t.result.slice(0, 200)}` : ''}`)
        .join('\n'),
    }
  })

  // The tools the model calls.
  on('tool.call', { tool: T_PEERS }, async $ => {
    const who = await read($, me)
    const list = await listPeers($, who ? who.id : '')
    return { result: list.length ? list.map(p => `${p.name} (${base(p.cwd)})`).join('\n') : 'No other sessions running.' }
  })

  on('tool.call', { tool: T_ASSIGN }, async ($, e) => {
    const who = await read($, me)
    if (!(await isHost($, who))) return { result: 'This session is not the host. The person must run /host first.' }
    const input = e as unknown as { worker?: string; task?: string }
    const worker = String(input.worker ?? '')
    const task = String(input.task ?? '')
    if (!worker || !task) return { result: 'Both worker and task are required.' }
    const list = await listPeers($, who.id)
    const chosen = worker === 'all' ? list : pick(list, worker)
    if (chosen.length === 0) return { result: `No session matches "${worker}".` }
    if (worker !== 'all' && chosen.length > 1) return { result: `"${worker}" is ambiguous: ${chosen.map(p => p.name).join(', ')}` }
    const out: string[] = []
    for (const p of chosen) {
      const f = await assign($, who, p, task)
      out.push(f ? `failed: ${f}` : `sent to ${p.name}`)
    }
    return { result: out.join('\n') }
  })

  on('tool.call', { tool: T_RENAME }, async ($, e) => {
    const who = await read($, me)
    if (!who || !(await isHost($, who))) return { result: 'This session is not the host. The person must run /host first.' }
    const input = e as unknown as { worker?: string; name?: string }
    const worker = String(input.worker ?? '')
    const name = cleanName(String(input.name ?? ''))
    if (!worker || !name) return { result: 'Both worker and name are required.' }
    const matches = pick(await listPeers($, who.id), worker)
    if (matches.length !== 1) return { result: matches.length ? `"${worker}" is ambiguous.` : `No session matches "${worker}".` }
    const failed = await renameWorker($, who, matches[0], name)
    return { result: failed ? `Not renamed: ${failed}` : `Asked ${matches[0].name} to rename itself to "${name}".` }
  })

  on('tool.call', { tool: T_REPORT }, async ($, e) => {
    const who = await read($, me)
    const input = e as unknown as { task_id?: string; result?: string }
    const id = String(input.task_id ?? '')
    const found = (await read($, inbox)).find(i => i.id === id)
    if (!who || !found) return { result: `No task ${id} was assigned to this session.` }
    const r = await $.session.send({
      to: { sessionId: found.hostId },
      text: `[RESULT ${id} from="${who.name}"]\n${String(input.result ?? '')}`,
    })
    return { result: r.isDelivered ? 'Result sent to the host.' : `Could not reach the host: ${r.reason}` }
  })

  on('command.run', { command: 'link' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions' })
    return { text: 'Session pane opened.' }
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const who = await read($, me)
    const list = await listPeers($, who ? who.id : '')
    const now = await $.clock.now()
    if (list.length === 0) return { text: 'No other sessions found. Start Claude Code in another terminal with this mod loaded.' }
    return { text: list.map(p => `${p.name}  ${base(p.cwd)}  ${ago(now - p.seen)}  (${p.id.slice(0, 8)})`).join('\n') }
  })

  on('command.run', { command: 'tell' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    if (!target || !text) return { text: 'Usage: /tell <session name or id> <message>' }
    const matches = pick(await listPeers($, who.id), target)
    if (matches.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (matches.length > 1) return { text: `"${target}" is ambiguous: ${matches.map(p => p.name).join(', ')}` }
    const failed = await deliver($, who, matches[0], text)
    return { text: failed ? `Not delivered. ${failed}` : `Sent to ${matches[0].name}.` }
  })

  on('command.run', { command: 'tellall' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /tellall <message>' }
    const list = await listPeers($, who.id)
    if (list.length === 0) return { text: 'No other sessions to tell.' }
    const failures: string[] = []
    for (const p of list) {
      const f = await deliver($, who, p, text)
      if (f) failures.push(f)
    }
    return { text: `Sent to ${list.length - failures.length}/${list.length} sessions.${failures.length ? '\n' + failures.join('\n') : ''}` }
  })

  // Record what other sessions say to this one; the model still reads it as usual.
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
      try {
        const now = await $.clock.now()
        const task = TASK_RE.exec(e.text)
        const result = RESULT_RE.exec(e.text)
        const rename = RENAME_RE.exec(e.text)
        if (task) {
          // A task is only taken from the session registered as the host.
          const h = await hostRecord($)
          if (h && h.id === task[2]) {
            const item: Inbox = { id: task[1], hostId: task[2], hostName: task[3], text: task[4].split('\n\nWhen you are finished')[0] }
            await update($, inbox, l => [...l, item].slice(-30))
            await remember($, { at: now, dir: 'in', who: `task ${item.id}`, text: item.text.slice(0, 300) })
            $.ui.toast(`Task ${item.id} from ${item.hostName}`)
            if (options.autoRun === true) {
              void $.prompt
                .submit({ text: `Task ${item.id} from host "${item.hostName}": ${item.text}\nWhen finished, call ${T_REPORT} with task_id "${item.id}" and a short result.` })
                .catch(() => {})
            }
          }
        } else if (rename) {
          // A rename is only taken from the session registered as the host.
          const h = await hostRecord($)
          const name = cleanName(rename[2])
          const who = await read($, me)
          if (h && h.id === rename[1] && name && who) {
            await $.command.run({ command: 'rename', args: name })
            const renamed: Me = { id: who.id, name }
            await update($, me, () => renamed)
            await announce($, renamed, await $.session.cwd())
            await remember($, { at: now, dir: 'in', who: h.name, text: `renamed this session to "${name}"` })
            $.ui.toast(`${h.name} renamed this session to "${name}"`)
          }
        } else if (result) {
          const id = result[1]
          const found = (await read($, tasks)).find(t => t.id === id)
          if (found) {
            await update($, tasks, l => l.map(t => (t.id === id ? { ...t, status: 'done' as const, result: result[3].slice(0, 2000) } : t)))
            await remember($, { at: now, dir: 'in', who: `${result[2]} ✓ ${id}`, text: result[3].slice(0, 300) })
            $.ui.toast(`${result[2]} finished ${id}`)
          }
        } else {
          await remember($, { at: now, dir: 'in', who: 'peer', text: e.text.slice(0, 300) })
        }
      } catch {
        // logging must never block delivery
      }
    }
    return next(e)
  })

  // /rename carries the new name as its argument: follow it at once, unless the option fixes one.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const who = await read($, me)
      const t = e.args.trim()
      if (who && t && !options.name && who.name !== t) {
        const renamed: Me = { id: who.id, name: t }
        await update($, me, () => renamed)
        await announce($, renamed, await $.session.cwd())
        $.ui.invalidate('ui.render')
      }
    } catch {
      // the name is cosmetic; never block /rename over it
    }
    return r
  })

  // Follow the name set with /rename, unless the option fixes one.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      const who = await read($, me)
      const t = e.session_title ? String(e.session_title) : ''
      if (who && t && !options.name && who.name !== t) {
        const renamed: Me = { id: who.id, name: t }
        await update($, me, () => renamed)
        await announce($, renamed, await $.session.cwd())
        $.ui.invalidate('ui.render')
      }
    } catch {
      // the name is cosmetic; never block a prompt over it
    }
    return next(e)
  })

  // Keep this session's listing fresh while it is in use.
  on('turn.complete', async ($, e, next) => {
    try {
      const who = await read($, me)
      if (who) await announce($, who, await $.session.cwd())
    } catch {
      // a failed heartbeat must never affect the turn
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const who = await read($, me)
      if (who) await $.store.delete(`peer:${who.id}`)
    } catch {
      // leaving quietly
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const who = await read($, me)
    const msgs = await read($, log)
    const myRole: Role = (await isHost($, who)) ? 'host' : 'solo'
    const board = await read($, tasks)
    const waiting = await read($, inbox)
    const pickedId = await read($, target)
    let list: Peer[] = []
    let now = 0
    try {
      now = await $.clock.now()
      list = await listPeers($, who ? who.id : '')
    } catch (err) {
      return <Text color="red">session-link error: {String(err)}</Text>
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">{who ? who.name : '…'}</Text>
        <Text>
          <Text dimColor>{who ? who.id.slice(0, 8) : ''} </Text>
          <Text bold color={myRole === 'host' ? 'yellow' : 'green'}>{myRole === 'host' ? '★ HOST' : 'worker'}</Text>
        </Text>
        <Text> </Text>

        <Text bold>OTHER SESSIONS</Text>
        {list.length === 0 ? <Text dimColor>none running</Text> : null}
        {list.map(p => (
          <Box key={p.id} flexDirection="column">
            <Text>
              <Text color="green">● </Text>
              <Text bold>{p.name}</Text>
              <Text dimColor> {ago(now - p.seen)}</Text>
            </Text>
            <Text dimColor>  {base(p.cwd)}  /tell {p.name} …</Text>
          </Box>
        ))}
        <Text> </Text>

        {myRole === 'host' ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>TASKS</Text>
            {board.length === 0 ? <Text dimColor>none yet · /assign name task</Text> : null}
            {board.slice(-6).map(t => (
              <Box key={t.id} flexDirection="column">
                <Text wrap="truncate">
                  <Text color={t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'yellow'}>
                    {t.status === 'done' ? '✓ ' : t.status === 'failed' ? '✗ ' : '… '}
                  </Text>
                  <Text bold>{t.toName} </Text>
                  <Text dimColor>{t.text}</Text>
                </Text>
                {t.result ? <Text wrap="truncate" color="green">    ⇒ {t.result.replace(/\s+/g, ' ')}</Text> : null}
              </Box>
            ))}
          </Box>
        ) : waiting.length ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>FROM THE HOST</Text>
            {waiting.slice(-4).map(i => (
              <Text key={i.id} wrap="truncate">
                <Text color="yellow">● </Text>
                <Text bold>{i.id} </Text>
                <Text dimColor>{i.text}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>PROMPT A WORKER</Text>
          {list.length === 0 ? (
            <Text dimColor>no other sessions yet</Text>
          ) : (
            <Box flexDirection="column">
              <Select
                key="target"
                label="to "
                value={pickedId}
                options={[{ value: 'all', label: 'all workers' }, ...list.map(p => ({ value: p.id, label: p.name }))]}
                onSelect={v => update($, target, () => v)}
              />
              <Input
                key="prompt"
                placeholder="type a task, Enter to send"
                submitLabel="send"
                onSubmit={async text => {
                  const task = text.trim()
                  if (!task || !who) return
                  if (myRole !== 'host') await setHost($, who, true)
                  const chosen = pickedId === 'all' ? list : list.filter(p => p.id === pickedId)
                  let ok = 0
                  for (const p of chosen) if (!(await assign($, who, p, task))) ok += 1
                  $.ui.toast(ok ? `Sent to ${ok} session${ok === 1 ? '' : 's'}` : 'Nothing was delivered')
                }}
              />
            </Box>
          )}
        </Box>

        <Text bold>MESSAGES</Text>
        {msgs.length === 0 ? <Text dimColor>nothing yet</Text> : null}
        {msgs.slice(-8).map((m, i) => (
          <Text key={`${m.at}-${i}`} wrap="truncate">
            <Text color={m.dir === 'in' ? 'yellow' : 'cyan'}>{m.dir === 'in' ? '← ' : '→ '}</Text>
            <Text bold>{m.who} </Text>
            <Text dimColor>{m.text}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Box>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => $.ui.invalidate('ui.render')} />
          <Text> </Text>
          <Button
            key="host"
            label={myRole === 'host' ? 'Stop hosting' : 'Become host'}
            onPress={() => (who ? setHost($, who, myRole !== 'host') : undefined)}
          />
        </Box>
      </Box>
    )
  })
}
