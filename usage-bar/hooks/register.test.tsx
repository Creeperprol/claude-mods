import { expect, test } from 'claude-code/testing'

const USAGE = {
  startedAt: 0,
  context: { percent: 42, tokens: 84000, window: 1000000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 2 },
    { kind: 'seven_day', percentUsed: 80 },
  ],
  cost: { usd: 0.7 },
}

const stand = (on: any, opened: string[]) => {
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.id', () => ({ value: 'aaaa1111-0000' }))
  on('clock.now', () => ({ value: 3600000 }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', () => ({ value: {} }))
  on('ui.open', (_$: any, e: any) => {
    opened.push(e.id)
    return { value: {} }
  })
}

const PANE = { plugin: 'usage-bar', component: 'Pane', requestId: 'usage-bar', props: { bodyColumns: 30 } } as const

test('auto-opens the pane at session start by default', async ($, on) => {
  const opened: string[] = []
  stand(on, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(opened).toContain('usage-bar')
})

test('does not auto-open when autoOpen is off', { options: { autoOpen: false } }, async ($, on) => {
  const opened: string[] = []
  stand(on, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(opened).not.toContain('usage-bar')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws the meters and buttons on ${surface}`, async ($, on) => {
    stand(on, [])
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ text: 'CONTEXT' })).toBeDefined()
    expect(await ui.find({ text: '42%' })).toBeDefined()
    expect(await ui.find({ text: 'WEEKLY' })).toBeDefined()
    expect(await ui.find({ text: '$0.70' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
  })
}

test('hide breakdown button toggles its label', async ($, on) => {
  stand(on, [])
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'where' })).toBeDefined()
  await ui.press({ key: 'where' } as any)
  expect(await ui.find({ text: 'Show breakdown' })).toBeDefined()
})

test('pane shows the session name from the prompt', async ($, on) => {
  stand(on, [])
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'mod' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ text: 'mod' })).toBeDefined()
})
