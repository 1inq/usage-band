import { expect, test } from 'claude-code/testing'

const USAGE = {
  startedAt: 0,
  context: { tokens: 180000, window: 1000000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 6, resetsAt: '2030-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 2, resetsAt: '2030-01-05T00:00:00Z' },
  ],
}
const CACHE = { read: 1, write: 0, input: 0, output: 0, lastRead: 100, lastIn: 100, lastAt: 1 }
const INFO = { model: 'claude-sonnet-5-5', branch: 'main', added: 12, removed: 3, files: 2 }

const band = (surface: 'terminal' | 'desktop', isCompact: boolean, cols: number) => ({
  plugin: 'usage-band',
  component: 'AbovePrompt',
  surface,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: cols, view: {}, scroll: { offset: 0, bodyRows: 10 } },
  isCompact,
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const isCompact of [false, true]) {
    test(`${surface} ${isCompact ? 'compact' : 'expanded'} draws bars and the info line`, async ($, on) => {
      on('clock.now', () => ({ value: 1_000_000 }))
      on('state.get', (_, e) => {
        const key = (e as { key?: string }).key
        const value = key === 'usage' ? USAGE : key === 'cache' ? CACHE : key === 'info' ? INFO : key === 'isCliOn' ? true : key === 'isCompact' ? isCompact : null
        return { value: { value, version: 1 } }
      })
      const { isCompact: _c, ...mount } = band(surface, isCompact, 100)
      const ui = await $.ui.mount(mount as never)
      // the info line: light-green additions, light-red removals
      expect((await ui.find({ type: 'Text', text: /\+12/ }))?.text).toMatch(/main.*\+12 -3$/)
      // a terminal draws its bars as block characters; a desktop as an Svg
      if (surface === 'terminal') {
        expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toContain('█')
        expect((await ui.find({ type: 'Text', text: /░/ }))?.text).toContain('░')
      }
      await ui.unmount()
    })
  }
}

test('cli-off hides the band in the terminal only', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('state.get', (_, e) => {
    const key = (e as { key?: string }).key
    const value = key === 'usage' ? USAGE : key === 'cache' ? CACHE : key === 'info' ? INFO : key === 'isCliOn' ? false : key === 'isCompact' ? false : null
    return { value: { value, version: 1 } }
  })
  const { isCompact: _c, ...term } = band('terminal', false, 100)
  const { isCompact: _d, ...desk } = band('desktop', false, 100)
  const t = await $.ui.mount(term as never)
  expect(await t.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await t.unmount()
  const d = await $.ui.mount(desk as never)
  expect((await d.find({ type: 'Text', text: /Context/ }))?.text).toContain('Context')
  await d.unmount()
})
