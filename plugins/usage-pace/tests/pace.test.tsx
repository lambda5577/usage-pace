import { expect, mock, test } from 'claude-code/testing'

import { formatSpan, labelOf, latest, paceOf, toneOf, verdictOf, waitOf, weekOfPlan } from '../hooks/pace'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-09T15:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const
// Three days and two hours into the week: day 4, hour 75 of 168, so the target is 44.6%.
const LEFT = 3 * DAY + 22 * HOUR
// Where each view draws: the label in the footer under the prompt, the bars in the band above it.
const FOOTER = { plugin: 'usage-pace', component: 'SessionMode', props: { modes: ['focus'] } } as const
const BAND = {
  plugin: 'usage-pace',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 90, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
// What the stand-in engine draws in the band when the mod leaves it alone.
const EMPTY_BAND = '(nothing)'

const iso = (ms: number) => new Date(ms).toISOString()

const reading = (percentUsed: number, leftMs: number, at = NOW) => ({ percentUsed, resetsAt: iso(NOW + leftMs), at })

const week = (percentUsed: number, leftMs: number) => [
  { kind: 'five_hour', percentUsed: 99, resetsAt: iso(NOW + HOUR) },
  { kind: 'seven_day', percentUsed, resetsAt: iso(NOW + leftMs) },
]

/** What the app's usage card answers: its three windows, the weekly one for all models at `percentUsed`. */
const plan = (percentUsed: number, leftMs: number) => ({
  plan: {
    status: 'ok',
    windows: [
      { label: '5-hour limit', percentUsed: 99, resetsAt: iso(NOW + HOUR) },
      { label: 'Weekly · Fable', percentUsed: 14, resetsAt: iso(NOW + leftMs) },
      { label: 'Weekly · all models', percentUsed, resetsAt: iso(NOW + leftMs - 312) },
    ],
  },
})

/**
 * Stands for the engine beneath the mod: a clock, the rate-limit windows it reports, its
 * own drawing of the footer and the band, and the store, which is the file every session
 * shares: `shared` is what it holds, for the test to write as another session would.
 */
function stage(on: any, limits: unknown[], stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const shared: Record<string, any> = { ...stored }
  // The desktop app's usage card: `app.card` is what it answers, null where no app is linked.
  const app: { card: unknown } = { card: null }
  const toasts: string[] = []
  on('store.get', (_$: any, e: any) => ({ value: shared[e.key] }))
  on('store.set', (_$: any, e: any) => {
    shared[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('mcp.call', (_$: any, e: any) => {
    if (app.card === null || e.server !== 'ccd_session_mgmt' || e.tool !== 'get_usage') throw new Error(`no such server: ${e.server}`)

    return { value: { content: [{ type: 'text', text: JSON.stringify(app.card) }], isError: false } }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: limits } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.component === 'SessionMode' ? `[${e.props.modes.join(' & ')}]` : EMPTY_BAND}</Text>
  })

  return { clock, shared, app, toasts }
}

/** A site as drawn: its texts in order, a space between them as a row's gap sets them. */
const shown = async (ui: any): Promise<string> => (await ui.findAll({ type: 'Text' })).map((each: any) => each.text).join(' ')

/** The whole of a drawing, the picture's source included, for looking a word up in. */
const drawn = async (ui: any): Promise<string> => JSON.stringify(await ui.drawn())

/** Which of the words the drawing lacks: a short failure where the whole drawing would be a page. */
const missing = (text: string, words: readonly string[]) => words.filter(word => !text.includes(word))

/** The color the used figure is drawn in. */
const colorOf = async (ui: any, used: string): Promise<unknown> => (await ui.find({ type: 'Text', text: used }))?.props.color

const run = (engine: any, args: string) => engine.command.run({ command: 'usage-pace', args } as any)

test('the target steps up every hour, to what an even pace has used by the end of the hour now running', () => {
  // Which of the week's 168 hours the target allows the use of, through its end.
  const hour = (leftMs: number) => Math.round(((paceOf(reading(0, leftMs), NOW)?.target ?? 0) * 168) / 100)
  expect(paceOf(reading(43, LEFT), NOW)).toMatchObject({ used: 43, day: 4, leftMs: LEFT })
  expect(hour(LEFT)).toBe(75)
  expect(labelOf(paceOf(reading(43, LEFT), NOW)!)).toBe('43% / 45% · 3d 22h')
  // The first hour of the week allows one 168th, and the first hour of day 2 a day and an hour.
  expect(hour(7 * DAY)).toBe(1)
  expect(hour(6 * DAY)).toBe(25)
  expect(labelOf(paceOf(reading(20, 6 * DAY), NOW)!)).toBe('20% / 15% · 6d 0h')
  // It holds through the hour and moves on at the next one.
  expect(hour(6 * DAY - 59 * 60_000)).toBe(25)
  expect(hour(6 * DAY - HOUR)).toBe(26)
  // The last hour of a day allows the whole day, and the last of the week all of it.
  expect(labelOf(paceOf(reading(35, 5 * DAY + HOUR), NOW)!)).toBe('35% / 29% · 5d 1h')
  expect(labelOf(paceOf(reading(97, 5 * HOUR + 12 * 60_000), NOW)!)).toBe('97% / 97% · 5h 12m')
  expect(paceOf(reading(0, 30 * 60_000), NOW)?.target).toBe(100)
})

test('the used figure is green on or under the target, orange a little over, red far over', () => {
  const pace = (percentUsed: number, leftMs = LEFT) => paceOf(reading(percentUsed, leftMs), NOW)!
  // Hour 75: the target is 44.6%, and a day's share on top of it is 58.9%.
  expect(toneOf(pace(43))).toBe('good')
  expect(toneOf(pace(45))).toBe('good')
  expect(toneOf(pace(46))).toBe('warning')
  expect(toneOf(pace(58))).toBe('warning')
  expect(toneOf(pace(59))).toBe('critical')
  expect(toneOf(pace(100, 5 * HOUR))).toBe('critical')
  expect(toneOf(paceOf({ percentUsed: 30, resetsAt: '', at: NOW }, NOW)!)).toBeNull()
  // And the bars view says the same in words.
  expect(verdictOf(pace(43))).toBe('2% under target')
  expect(verdictOf(pace(45))).toBe('On target')
  expect(verdictOf(pace(50))).toBe('5% over target')
  expect(verdictOf(pace(100, 5 * HOUR))).toBe('Weekly limit reached')
})

test('over target, the wait is how long until the target catches up, in whole hours', () => {
  const wait = (percentUsed: number, leftMs = LEFT) => waitOf(paceOf(reading(percentUsed, leftMs), NOW)!)
  // 74 hours in, hour 75. 50% is what hour 84 allows, and hour 84 begins at 83 hours in.
  expect(wait(50)).toBe('on target in 9h')
  expect(wait(80)).toBe('on target in 60h')
  // Half an hour further into the hour, the same catch-up is half an hour nearer: still said as 9h.
  expect(wait(50, LEFT - 30 * 60_000)).toBe('on target in 9h')
  // 45.2% is what the very next hour allows: that is minutes away.
  expect(wait(45.2, LEFT - 30 * 60_000)).toBe('on target in 30m')
  // On or under the target there is nothing to wait for, and a spent limit does not come back.
  expect(wait(43)).toBe('')
  expect(wait(45)).toBe('')
  expect(wait(100)).toBe('')
  expect(waitOf(paceOf({ percentUsed: 30, resetsAt: '', at: NOW }, NOW)!)).toBe('')
})

test('a reading from a week that is over is dropped, and one with no reset time shows its figure alone', () => {
  expect(paceOf(reading(80, -HOUR), NOW)).toBeNull()
  expect(labelOf(paceOf({ percentUsed: 30, resetsAt: '', at: NOW }, NOW)!)).toBe('30%')
})

test('a stretch of time reads in its two largest units', () => {
  expect(formatSpan(3 * DAY + 22 * HOUR + 59_000)).toBe('3d 22h')
  expect(formatSpan(5 * HOUR + 12 * 60_000)).toBe('5h 12m')
  expect(formatSpan(8 * 60_000)).toBe('8m')
})

test('of two readings the one that says more about the week stands', () => {
  const left = 3 * DAY
  // Within a week the one read last is the truth, whichever way each was found.
  expect(latest(reading(44, left, NOW - HOUR), reading(49, left, NOW)).percentUsed).toBe(49)
  expect(latest(reading(49, left, NOW), reading(44, left, NOW - HOUR)).percentUsed).toBe(49)
  // A weekly reset, once used, empties the week and keeps its reset time: the lower figure read later stands.
  expect(latest(reading(73, left, NOW - DAY), reading(2, left, NOW)).percentUsed).toBe(2)
  // The same figure read again is the fresher reading, and of two read at once the one just found.
  expect(latest(reading(44, left, NOW - HOUR), reading(44, left, NOW)).at).toBe(NOW)
  expect(latest(reading(44, left, NOW), reading(52, left, NOW)).percentUsed).toBe(52)
  // A reading of unknown age, read at 0, never puts its figure over a dated one.
  expect(latest(reading(44, left, NOW - DAY), reading(73, left, 0)).percentUsed).toBe(44)
  // A new week starts low, and its reading still replaces the old week's.
  expect(latest(reading(96, HOUR), reading(2, 7 * DAY + HOUR)).percentUsed).toBe(2)
  expect(latest(null, reading(7, left)).percentUsed).toBe(7)
})

test('the app\'s usage card is read for the week of all models', () => {
  expect(weekOfPlan(plan(52, 3 * DAY), NOW)).toMatchObject({ percentUsed: 52, at: NOW })
  expect(weekOfPlan({ plan: { status: 'unavailable' } }, NOW)).toBeNull()
  expect(weekOfPlan(null, NOW)).toBeNull()
  // A reset the app names a fraction of a second early is the same minute.
  expect(paceOf(weekOfPlan(plan(52, LEFT), NOW)!, NOW)?.leftMs).toBe(LEFT)
})

for (const surface of SURFACES) {
  test(`${surface}: the label view puts one label in the footer, ahead of its own, and leaves the band alone`, async ($, on) => {
    const { clock } = stage(on, week(43, LEFT))
    await $.session.start({ cwd: '/w', surface, isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...FOOTER, surface })
    const band = await $.ui.mount({ ...BAND, surface })
    // The five-hour window is another limit: it never reaches the label.
    expect(await shown(ui)).toBe('43% / 45% · 3d 22h & focus')
    expect(await colorOf(ui, '43%')).toBe('success')
    expect(await shown(band)).toBe(EMPTY_BAND)

    await $.session.measure({ context: { window: 200_000 }, rateLimits: week(50, LEFT), changed: ['rateLimits'] })
    await clock.settle()
    expect(await shown(ui)).toBe('50% / 45% · 3d 22h & focus')
    expect(await colorOf(ui, '50%')).toBe('warning')

    await $.session.measure({ context: { window: 200_000 }, rateLimits: week(80, LEFT), changed: ['rateLimits'] })
    await clock.settle()
    expect(await colorOf(ui, '80%')).toBe('error')
    // Only the used figure takes the color.
    expect((await ui.find({ type: 'Text', text: '/ 45%' }))?.props.color).toBeUndefined()
    await band.unmount()
    await ui.unmount()
  })

  test(`${surface}: with no reading the footer is the engine's own, and a kept reading fills in`, async ($, on) => {
    const { clock } = stage(on, [], { reading: reading(20, 6 * DAY + HOUR, NOW - 2 * HOUR) })
    const empty = await $.ui.mount({ ...FOOTER, surface })
    expect(await shown(empty)).toBe('[focus]')
    await empty.unmount()

    await $.session.start({ cwd: '/w', surface, isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...FOOTER, surface })
    expect(await shown(ui)).toBe('20% / 14% · 6d 1h & focus')
    await ui.unmount()
  })

  test(`${surface}: /usage-pace bars moves it to bars above the prompt, and switch moves it back`, async ($, on) => {
    const { clock, shared } = stage(on, week(43, LEFT))
    await $.session.start({ cwd: '/w', surface, isInteractive: true })
    await clock.settle()
    const footer = await $.ui.mount({ ...FOOTER, surface })
    const band = await $.ui.mount({ ...BAND, surface })

    expect((await run($, 'bars')).text).toBe('usage-pace now shows as bars above the prompt. Your other open sessions follow within a minute.')
    await clock.settle()
    const text = await drawn(band)
    expect(missing(text, ['Used', 'Target', '43%', '45%', '2% under target', 'Day 4/7', '3d 22h left', 'resets ', '⟳'])).toEqual([])
    expect(text.includes('99%')).toBe(false)
    expect(text.includes('<svg')).toBe(surface === 'desktop')
    // Under target there is no wait to say; over it, the wait stands beside the verdict.
    expect(text.includes('on target in')).toBe(false)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: week(50, LEFT), changed: ['rateLimits'] })
    await clock.settle()
    expect(missing(await drawn(band), ['50%', '5% over target', 'on target in 9h'])).toEqual([])
    // The footer is the engine's own again, and the choice is saved for the other sessions.
    expect(await shown(footer)).toBe('[focus]')
    expect(shared.view).toBe('bars')

    expect((await run($, 'switch')).text).toBe('usage-pace now shows as a label under the prompt. Your other open sessions follow within a minute.')
    await clock.settle()
    expect(await shown(footer)).toBe('50% / 45% · 3d 22h & focus')
    expect(await shown(band)).toBe(EMPTY_BAND)
    expect(shared.view).toBe('label')
    await band.unmount()
    await footer.unmount()
  })
}

test('a session starts in the view the others saved, and follows a change of it at its next tick', async ($, on) => {
  const { clock, shared } = stage(on, week(43, LEFT), { view: 'bars' })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await shown(footer)).toBe('[focus]')
  expect(missing(await drawn(band), ['2% under target'])).toEqual([])

  // Another session, or a hand, wrote the other view into the store.
  shared.view = 'label'
  await clock.advance(60_000)
  await clock.settle()
  expect(await shown(footer)).toBe('43% / 45% · 3d 21h & focus')
  expect(await shown(band)).toBe(EMPTY_BAND)
  await band.unmount()
  await footer.unmount()
})

test('a word that names no view changes nothing and says what does', async ($, on) => {
  const { clock, shared } = stage(on, week(43, LEFT))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect((await run($, 'sideways')).text).toBe('"sideways" is not a view. /usage-pace label, /usage-pace bars or /usage-pace switch changes the view; /usage-pace alone fetches the latest figure.')
  expect(shared.view).toBeUndefined()
})

test('on the desktop the refresh button stays beside the bars, at the right, however wide the band', async ($, on) => {
  const { clock } = stage(on, week(43, LEFT), { view: 'bars' })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const bodyColumns of [50, 97, 140]) {
    const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'desktop' })
    const row: any = await band.drawn()
    // One row that never wraps: the picture, which gives way, then the button, which does not.
    expect(row.props).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', justifyContent: 'space-between' })
    const [picture, refresh] = row.children
    expect(picture.props).toMatchObject({ flexShrink: 1, minWidth: 0 })
    expect(refresh.props).toMatchObject({ flexShrink: 0 })
    expect(refresh.children[0]).toMatchObject({ type: 'Button', props: { key: 'refresh' } })
    // The Svg names no size, so it is drawn smaller where its slot is; it is sized to leave the button room.
    const svg = picture.children[0]
    expect(svg.type).toBe('Svg')
    expect(svg.props.width).toBeUndefined()
    const width = Number(/width="(\d+)"/.exec(String(svg.props.source))?.[1])
    expect(bodyColumns * 7.5 - width).toBeGreaterThanOrEqual(56)
    await band.unmount()
  }
})

test('the bars view\'s refresh button asks the app and shows its figure', async ($, on) => {
  const { clock, shared, app, toasts } = stage(on, week(44, LEFT), { view: 'bars' })
  app.card = plan(52, LEFT)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(missing(await drawn(band), ['44%'])).toEqual([])

  await band.press({ key: 'refresh' })
  await clock.settle()
  const text = await drawn(band)
  expect(missing(text, ['52%', '⟳'])).toEqual([])
  expect(text.includes('44%')).toBe(false)
  expect(toasts).toEqual(['Weekly usage, fresh from the app (used / target · time left): 52% / 45% · 3d 22h'])
  expect(shared.reading.percentUsed).toBe(52)
  await band.unmount()
})

test('the time left counts down and the target steps up with no new reading', async ($, on) => {
  const { clock } = stage(on, week(43, LEFT))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const before = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(before)).toBe('43% / 45% · 3d 22h & focus')
  await before.unmount()

  // Two hours on, the week has two hours less and the target two hours' share more.
  await clock.advance(2 * HOUR)
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(ui)).toBe('43% / 46% · 3d 20h & focus')
  await ui.unmount()
})

test('a reading another session saved reaches this one at its next tick', async ($, on) => {
  const { clock, shared } = stage(on, week(44, LEFT))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(ui)).toBe('44% / 45% · 3d 22h & focus')
  expect(shared.reading.percentUsed).toBe(44)

  // Another session got a reply and saved what it learned.
  shared.reading = reading(49, LEFT, NOW + 30_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(await shown(ui)).toBe('49% / 45% · 3d 21h & focus')
  await ui.unmount()
})

test('a session that sat idle does not put its old figure over the shared one', async ($, on) => {
  // Its last reply said 44%; since then another session saved 49%.
  const { clock, shared } = stage(on, week(44, LEFT), { reading: reading(49, LEFT, NOW - 10 * 60_000) })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(ui)).toBe('49% / 45% · 3d 22h & focus')
  expect(shared.reading).toEqual(reading(49, LEFT, NOW - 10 * 60_000))

  // Its own next reply, a point further on, is saved for the others.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: week(50, LEFT), changed: ['rateLimits'] })
  await clock.settle()
  expect(await shown(ui)).toBe('50% / 45% · 3d 22h & focus')
  expect(shared.reading.percentUsed).toBe(50)
  await ui.unmount()
})

test('after a weekly reset is used, the next reply\'s lower figure replaces the fuller one every session kept', async ($, on) => {
  // Before the reset this session's last reply, and the store, said 73%; the reset time stays.
  const { clock, shared } = stage(on, week(73, LEFT), { reading: reading(73, LEFT, NOW - DAY) })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(ui)).toBe('73% / 45% · 3d 22h & focus')

  await $.session.measure({ context: { window: 200_000 }, rateLimits: week(2, LEFT), changed: ['rateLimits'] })
  await clock.settle()
  expect(await shown(ui)).toBe('2% / 45% · 3d 22h & focus')
  expect(shared.reading).toEqual(reading(2, LEFT, NOW))

  await ui.unmount()

  // The next tick settles with the store again, and the fuller figure from before the reset stays gone.
  await clock.advance(60_000)
  await clock.settle()
  const later = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(later)).toBe('2% / 45% · 3d 21h & focus')
  expect(shared.reading.percentUsed).toBe(2)
  await later.unmount()
})

test('a session that sat idle since before a weekly reset takes the lower figure another session saved', async ($, on) => {
  // Its own last reply said 73%; another session's reply since the reset saved 4%.
  const { clock, shared } = stage(on, week(73, LEFT), { reading: reading(73, LEFT, NOW - DAY) })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  shared.reading = reading(4, LEFT, NOW + 30_000)

  await clock.advance(60_000)
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect(await shown(ui)).toBe('4% / 45% · 3d 21h & focus')
  expect(shared.reading.percentUsed).toBe(4)
  await ui.unmount()
})

test('after a weekly reset is used, /usage-pace takes the app\'s lower figure', async ($, on) => {
  const { clock, shared, app } = stage(on, week(73, LEFT), { reading: reading(73, LEFT, NOW - DAY) })
  app.card = plan(23, LEFT)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect((await run($, '')).text).toBe('Weekly usage, fresh from the app (used / target · time left): 23% / 45% · 3d 22h')
  expect(shared.reading.percentUsed).toBe(23)
})

test('/usage-pace asks the app, shows its figure and saves it for the other sessions', async ($, on) => {
  const { clock, shared, app } = stage(on, week(44, LEFT))
  app.card = plan(52, LEFT)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })

  const said = await run($, '')
  await clock.settle()
  expect(said.text).toBe('Weekly usage, fresh from the app (used / target · time left): 52% / 45% · 3d 22h')
  expect(await shown(ui)).toBe('52% / 45% · 3d 22h & focus')
  expect(shared.reading.percentUsed).toBe(52)
  await ui.unmount()
})

test('with no app to ask, /usage-pace falls back to the newest reading any session kept', async ($, on) => {
  const { clock, shared } = stage(on, week(44, LEFT))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  shared.reading = reading(47, LEFT, NOW + 5_000)

  const said = await run($, '')
  expect(said.text).toBe('Weekly usage, no live figure in this session, so the newest reading from your sessions (used / target · time left): 47% / 45% · 3d 22h')
})
