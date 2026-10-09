import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snap } from '../types'

const PANE = 'usage-bar'
const snap = atom({ plugin: 'usage-bar', key: 'snap' } as const, null)
const showTools = atom({ plugin: 'usage-bar', key: 'showTools' } as const, true)
const showWhere = atom({ plugin: 'usage-bar', key: 'showWhere' } as const, true)
const title = atom({ plugin: 'usage-bar', key: 'title' } as const, '')

const human = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const tone = (p: number) => (p < 50 ? 'cyan' : p < 75 ? 'yellow' : p < 90 ? 'magenta' : 'red')

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Smooth bar: full cells, one partial eighth, then a dim track.
const bar = (p: number, width: number) => {
  const cells = (Math.min(100, Math.max(0, p)) / 100) * width
  const full = Math.floor(cells)
  const part = EIGHTHS[Math.floor((cells - full) * 8)]
  return { fill: '█'.repeat(full) + part, track: '░'.repeat(Math.max(0, width - full - (part ? 1 : 0))) }
}

const LABEL: Record<string, string> = { five_hour: '5-HOUR', seven_day: 'WEEKLY', spend_limit: 'SPEND' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const reset = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? `resets ${hm}` : `resets ${DAYS[d.getDay()]} ${hm}`
}

const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

type Usage = {
  startedAt: number
  context: { percent?: number; tokens?: number; window: number; breakdown?: any }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const toSnap = (u: Usage, prev: Snap | null): Snap => {
  const b = u.context.breakdown
  return {
    percent: u.context.percent ?? 0,
    tokens: u.context.tokens ?? 0,
    window: u.context.window,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    usd: u.cost ? u.cost.usd : null,
    startedAt: u.startedAt,
    model: b ? b.model : (prev ? prev.model : ''),
    cats: b
      ? b.categories
          .filter((c: any) => c.kind === 'used' && c.tokens > 0)
          .map((c: any) => ({ name: c.name, tokens: c.tokens }))
          .sort((a: any, z: any) => z.tokens - a.tokens)
      : (prev ? prev.cats : []),
    compactAt: b ? (b.autoCompactThreshold ?? null) : (prev ? prev.compactAt : null),
  }
}

// detail: also itemise the window (local estimate, free); the light call keeps the last itemising.
async function refresh($: any, detail: boolean) {
  const prev = await read($, snap)
  const u = await $.session.usage(detail ? { breakdown: 'summary' } : undefined)
  await update($, snap, () => toSnap(u, prev))
  $.ui.invalidate('ui.render')
}

type Call = { id: string; tool: string; hint: string; isDone: boolean }

const hintOf = (input: any): string => {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? ''
  return String(v).replace(/\s+/g, ' ').slice(0, 60)
}

export const register: Register = (on, options) => {
  let turns = 0
  let tools = 0
  let calls: Call[] = []
  const counts: Record<string, number> = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-bar', description: 'Open the usage meters in a side pane' })
    if (options.autoOpen !== false) void $.ui.open({ id: PANE, title: 'Usage' })
    await refresh($, true)
    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage' })
    return { text: 'Usage pane opened.' }
  })

  // /rename carries the new name as its argument: update the pane the moment it runs.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const n = e.args.trim()
      if (n) await update($, title, () => n)
    } catch {
      // cosmetic only
    }
    return r
  })

  // A resumed session already has its name when it starts.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.session_title) await update($, title, () => String(e.session_title))
    } catch {
      // cosmetic only
    }
    return next(e)
  })

  // The session's name (set with /rename) rides every prompt as session_title.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      if (e.session_title) await update($, title, () => String(e.session_title))
    } catch {
      // the name is cosmetic; never block a prompt over it
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    turns += 1
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, true)
    return next(e)
  })

  // Keep the meters moving between turns: refresh after every tool call.
  on('tool.call', async ($, e, next) => {
    tools += 1
    counts[e.tool] = (counts[e.tool] ?? 0) + 1
    const call: Call = { id: e.tool_use_id ?? `${e.tool}-${tools}`, tool: e.tool, hint: hintOf(e), isDone: false }
    calls = [...calls, call].slice(-12)
    $.ui.invalidate('ui.render')
    const r = await next(e)
    calls = calls.map(c => (c.id === call.id ? { ...c, isDone: true } : c))
    try {
      await refresh($, false)
    } catch {
      // a failed refresh must never affect the tool call
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    let s: Snap
    let now = 0
    let isTools = true
    let isWhere = true
    let name = ''
    let sid = ''
    try {
      s = (await read($, snap)) ?? toSnap(await $.session.usage({ breakdown: 'summary' }), null)
      now = await $.clock.now()
      isTools = await read($, showTools)
      isWhere = await read($, showWhere)
      name = await read($, title)
      sid = (await $.session.id()).slice(0, 8)
    } catch (err) {
      return <Text color="red">usage error: {String(err)}</Text>
    }

    const width = Math.max(8, (e.props.bodyColumns ?? 30) - 2)
    const age = Math.max(1, now - s.startedAt)
    const perHour = s.usd !== null ? (s.usd / age) * 3600000 : null

    const Meter = ({ label, p, note }: { label: string; p: number; note?: string }) => {
      const b = bar(p, width)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold>{label}</Text>
            <Text bold color={tone(p)}>  {Math.round(p)}%</Text>
          </Box>
          <Text>
            <Text color={tone(p)}>{b.fill}</Text>
            <Text dimColor>{b.track}</Text>
          </Text>
          {note ? <Text dimColor>{note}</Text> : null}
        </Box>
      )
    }

    const Row = ({ k, v, color }: { k: string; v: string; color?: string }) => (
      <Box>
        <Text dimColor>{k.padEnd(10)}</Text>
        <Text bold color={color}>{v}</Text>
      </Box>
    )

    const top = s.cats.slice(0, 6)
    const biggest = top.length ? top[0].tokens : 1

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="white">{name || 'untitled session'}</Text>
        <Text dimColor>{sid}</Text>
        {s.model ? <Text bold color="cyan">{s.model}</Text> : null}
        <Text dimColor>session {span(age)}</Text>
        <Text> </Text>

        <Meter
          label="CONTEXT"
          p={s.percent}
          note={`${human(s.tokens)} / ${human(s.window)} tokens${
            s.compactAt ? ` · compacts at ${human(s.compactAt)}` : ''
          }`}
        />
        {s.limits.map(l => (
          <Meter key={l.kind} label={LABEL[l.kind] ?? l.kind} p={l.percentUsed} note={reset(l.resetsAt)} />
        ))}

        {top.length ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>WHERE CONTEXT GOES</Text>
            {(isWhere ? top : []).map(c => {
              const b = bar((c.tokens / biggest) * 100, 6)
              return (
                <Text key={c.name}>
                  <Text color="cyan">{b.fill}</Text>
                  <Text dimColor>{b.track} </Text>
                  <Text>{c.name} </Text>
                  <Text dimColor>{human(c.tokens)}</Text>
                </Text>
              )
            })}
            {isWhere && s.cats.length > top.length ? (
              <Text dimColor>+{s.cats.length - top.length} more</Text>
            ) : null}
          </Box>
        ) : null}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>TOOLS</Text>
          {calls.length === 0 ? <Text dimColor>none yet</Text> : null}
          {(isTools ? calls.slice(-5) : []).map(c => (
            <Text key={c.id} wrap="truncate">
              <Text color={c.isDone ? 'green' : 'yellow'}>{c.isDone ? '✓ ' : '● '}</Text>
              <Text bold={!c.isDone}>{c.tool}</Text>
              <Text dimColor> {c.hint}</Text>
            </Text>
          ))}
          {Object.keys(counts).length ? (
            <Text dimColor>
              {Object.entries(counts)
                .sort((a, z) => z[1] - a[1])
                .slice(0, 4)
                .map(([k, n]) => `${k}×${n}`)
                .join('  ')}
            </Text>
          ) : null}
        </Box>

        <Text bold>SESSION</Text>
        <Row k="turns" v={String(turns)} />
        <Row k="tool calls" v={String(tools)} />
        {s.usd !== null ? <Row k="cost" v={`$${s.usd.toFixed(2)}`} color="green" /> : null}
        {perHour !== null && age > 120000 ? <Row k="burn" v={`$${perHour.toFixed(2)}/h`} /> : null}

        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($, true)} />
            <Text> </Text>
            <Button
              key="reset"
              label="Reset counts"
              onPress={() => {
                turns = 0
                tools = 0
                calls = []
                for (const k of Object.keys(counts)) delete counts[k]
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
          <Box>
            <Button
              key="tools"
              label={isTools ? 'Hide tools' : 'Show tools'}
              onPress={() => update($, showTools, v => !v)}
            />
            <Text> </Text>
            <Button
              key="where"
              label={isWhere ? 'Hide breakdown' : 'Show breakdown'}
              onPress={() => update($, showWhere, v => !v)}
            />
          </Box>
        </Box>
      </Box>
    )
  })
}
