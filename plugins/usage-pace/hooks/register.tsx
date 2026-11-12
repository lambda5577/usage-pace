import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Reading, View } from '../types'
import { card } from './art'
import { altOf, DAYS, labelOf, latest, metaOf, paceOf, restLabel, targetLabel, type Tone, toneOf, usedLabel, verdictOf, waitOf, weekOfPlan } from './pace'

const WINDOW = 'seven_day'
// What every session shares, in the store: the newest reading, and which view shows.
const READING_KEY = 'reading'
const VIEW_KEY = 'view'
const SAID: Record<View, string> = { label: 'a label under the prompt', bars: 'bars above the prompt' }
// The desktop app's own tool for the figures its usage card shows: read-only, and no
// request to a model, so asking it costs nothing of the limit it reports.
const APP_SERVER = 'ccd_session_mgmt'
const APP_TOOL = 'get_usage'
const REFRESH_TIMEOUT_MS = 10_000
// How often the view draws again and takes what another session saved: a newer reading,
// another view. The time left moves on its own, with no reply to redraw for.
const TICK_MS = 60_000
// Theme keys, so the colors follow the person's theme, light or dark.
const COLOR: Record<Tone, string> = { good: 'success', warning: 'warning', critical: 'error' }
const PLAIN = 'suggestion'
const MARK: Record<Tone, string> = { good: '✓', warning: '▲', critical: '■' }
// The bars view. A cell of the desktop's band is about this wide, or a little less: under
// rather than over, as a picture too wide pushes the button onto a row of its own.
const CELL_PX = 7.5
const WIDEST_PX = 760
const NARROWEST_PX = 300
// What the refresh button takes of the desktop band's width beside the picture: the native
// button, the gap before it and the band's own padding, with some to spare.
const REFRESH_PX = 56
// What the refresh button takes of the terminal's width, beside the bars.
const REFRESH_CELLS = 5
// The refresh button's mark: the reload circle with its gap at the right, a quarter turn on from ↻.
const REFRESH_MARK = '⟳'
const TERMINAL_BAR = 28
const LABEL_CELLS = 6
const VALUE_CELLS = 4
// What the terminal's rows hold beside the bar: the label, the value, the notes and the button.
const BESIDE_CELLS = 58 + REFRESH_CELLS

const readingAtom = atom({ plugin: 'usage-pace', key: 'reading' } as const, null)
const viewAtom = atom({ plugin: 'usage-pace', key: 'view' } as const, 'label')
const refreshingAtom = atom({ plugin: 'usage-pace', key: 'isRefreshing' } as const, false)

let ticker: Timer | null = null

const quietly = (work: Promise<unknown>) => void work.catch(() => undefined)

const isReading = (value: unknown): value is Reading =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Reading).percentUsed === 'number' &&
  typeof (value as Reading).resetsAt === 'string' &&
  typeof (value as Reading).at === 'number'

const isSame = (one: Reading, other: Reading) => one.percentUsed === other.percentUsed && one.resetsAt === other.resetsAt && one.at === other.at

const isView = (value: unknown): value is View => value === 'label' || value === 'bars'

/** The week's window out of a set of rate-limit windows, as read at `at`; null when it names none. */
function weekOf(limits: readonly SessionRateLimit[], at: number): Reading | null {
  const week = limits.find(each => each.kind === WINDOW)

  return week ? { percentUsed: week.percentUsed, resetsAt: week.resetsAt ?? '', at } : null
}

/**
 * Settles this session's reading with the one every session shares, and with `found`
 * when a reply brought one: the store is a file all of them read and write, so a reply
 * in any session reaches the others at their next tick.
 */
async function settle($: EngineInterface, found: Reading | null = null): Promise<void> {
  const kept = await $.store.get(READING_KEY)
  const shared = isReading(kept) ? kept : null
  const held = await read($, readingAtom)
  let best = held
  if (shared) best = latest(best, shared)
  if (found) best = latest(best, found)
  if (!best) return

  // A reading of unknown age loses to any dated one: where it is all there is, it is the best known as of now.
  const settled = best.at === 0 ? { ...best, at: await $.clock.now() } : best
  if (!held || !isSame(held, settled)) await update($, readingAtom, current => (current ? latest(current, settled) : settled))
  if (!shared || !isSame(shared, settled)) await $.store.set(READING_KEY, settled)
}

/** Takes the view every session shares, when another session (or a hand) changed it. */
async function follow($: EngineInterface): Promise<void> {
  const kept = await $.store.get(VIEW_KEY)
  if (isView(kept) && kept !== (await read($, viewAtom))) await update($, viewAtom, () => kept)
}

/** Shows `view` here at once, and saves it for every other session to follow. */
async function show($: EngineInterface, view: View): Promise<void> {
  await update($, viewAtom, () => view)
  await $.store.set(VIEW_KEY, view)
}

/** What a tool's result carries as data: its structured result, or its text read as JSON. */
function dataOf(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent

  try {
    return JSON.parse(result.content.find(each => each.type === 'text')?.text ?? '')
  } catch {
    return null
  }
}

/** The week as the desktop app's usage card has it right now; null where no app answers. */
async function askApp($: EngineInterface): Promise<Reading | null> {
  const late = new Promise<null>(done => $.clock.after(REFRESH_TIMEOUT_MS, () => done(null)))
  const asked = $.mcp
    .call(APP_SERVER, APP_TOOL, {})
    .then(async result => (result.isError ? null : weekOfPlan(dataOf(result), await $.clock.now())))
    .catch(() => null)

  return Promise.race([asked, late])
}

/** The app's figure where an app answers, else the newest any session has kept; says which it was. */
async function refresh($: EngineInterface): Promise<string> {
  const fresh = await askApp($)
  await settle($, fresh)
  const held = await read($, readingAtom)
  const pace = held ? paceOf(held, await $.clock.now()) : null
  if (!pace) return "No usage reading yet. It shows after Claude's next reply."

  const from = fresh ? 'fresh from the app' : 'no live figure in this session, so the newest reading from your sessions'

  return `Weekly usage, ${from} (used / target · time left): ${labelOf(pace)}`
}

/** The bars view's refresh button: one request at a time, its outcome in a toast. */
async function press($: EngineInterface): Promise<void> {
  if (await read($, refreshingAtom)) return

  await update($, refreshingAtom, () => true)
  try {
    $.ui.toast(await refresh($))
  } finally {
    await update($, refreshingAtom, () => false)
  }
}

/** What the session knew before this load: as old as its last reply, which nothing dates. */
async function seed($: EngineInterface): Promise<void> {
  await follow($)
  await settle($, weekOf((await $.session.usage()).rateLimits, 0))
}

const bar = (percent: number, cells: number) => {
  const filled = Math.max(percent > 0 ? 1 : 0, Math.round((Math.min(100, percent) / 100) * cells))

  return { filled: '█'.repeat(filled), rest: '░'.repeat(cells - filled) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-pace', description: 'Fetch the latest weekly usage, or switch its view', argumentHint: '[label|bars|switch]' })
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      quietly(settle($))
      quietly(follow($))
      $.ui.invalidate('ui.render')
    })
    quietly(seed($))

    return next(e)
  })

  on('session.measure', ($, e, next) => {
    // A measurement follows a reply, so its figures are as fresh as now.
    quietly($.clock.now().then(now => settle($, weekOf(e.rateLimits, now))))

    return next(e)
  })

  on('command.run', { command: 'usage-pace' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (!asked) return { text: await refresh($) }

    const shown = await read($, viewAtom)
    const view = asked === 'switch' ? (shown === 'label' ? 'bars' : 'label') : isView(asked) ? asked : null
    if (!view) return { text: `"${asked}" is not a view. /usage-pace label, /usage-pace bars or /usage-pace switch changes the view; /usage-pace alone fetches the latest figure.` }

    await show($, view)

    return { text: `usage-pace now shows as ${SAID[view]}. Your other open sessions follow within a minute.` }
  })

  // The label view: one more label among the footer's own, ahead of them. The mod draws the
  // row itself: the desktop app shows no label a mod only hands it, and a color needs a text of its own.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if ((await read($, viewAtom)) !== 'label') return next(e)

    const reading = await read($, readingAtom)
    const pace = reading ? paceOf(reading, await $.clock.now()) : null
    if (!pace) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const tone = toneOf(pace)
    const rest = [restLabel(pace), ...e.props.modes.map(mode => `& ${mode}`)].filter(Boolean).join(' ')
    // The terminal's own labels are dim; the desktop app's text is already the footer's.
    const isDim = e.surface === 'terminal'

    return (
      <Box flexDirection="row" gap={1}>
        {tone ? <Text color={COLOR[tone]}>{usedLabel(pace)}</Text> : <Text dimColor={isDim}>{usedLabel(pace)}</Text>}
        {rest && <Text dimColor={isDim}>{rest}</Text>}
      </Box>
    )
  })

  // The bars view: the used bar over the target bar in the band above the prompt, with a refresh button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, viewAtom)) !== 'bars') return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const reading = await read($, readingAtom)
    const now = await $.clock.now()
    const pace = reading ? paceOf(reading, now) : null
    const button = <Button key="refresh" label={(await read($, refreshingAtom)) ? '…' : REFRESH_MARK} onPress={() => quietly(press($))} />
    if (!reading || !pace) {
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>Weekly limit: no reading yet. It shows after Claude's next reply.</Text>
          {button}
        </Box>
      )
    }

    const tone = toneOf(pace)
    const meta = metaOf(pace, reading, now)
    const wait = waitOf(pace)
    // The terminal's table names Svg too and then refuses the tree: the surface decides, not the table.
    if (e.surface !== 'terminal' && 'Svg' in table) {
      const { Svg } = table
      const width = Math.max(NARROWEST_PX, Math.min(WIDEST_PX, Math.floor(e.props.bodyColumns * CELL_PX - REFRESH_PX)))
      const art = card({ meta, verdict: verdictOf(pace), wait: waitOf(pace), tone, used: pace.used, usedLabel: usedLabel(pace), target: pace.target, targetLabel: targetLabel(pace), days: DAYS }, width)

      // One row that never wraps: the bars on the left, the button at the right edge, centered
      // on the two of them. Where the band is narrower than guessed the picture gives way,
      // drawn smaller in its slot, and the button keeps its place; so the Svg names no size.
      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" justifyContent="space-between" gap={1}>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Svg source={art.source} alt={altOf(pace, reading, now)} />
          </Box>
          <Box flexShrink={0}>{button}</Box>
        </Box>
      )
    }

    const cells = Math.max(10, Math.min(TERMINAL_BAR, e.props.bodyColumns - BESIDE_CELLS))
    const used = bar(pace.used, cells)
    const target = pace.target === null ? null : bar(pace.target, cells)
    const color = tone ? COLOR[tone] : PLAIN

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box width={LABEL_CELLS}>
            <Text dimColor>Used</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={color}>{used.filled}</Text>
            <Text dimColor>{used.rest}</Text>
          </Box>
          <Box width={VALUE_CELLS} justifyContent="flex-end">
            <Text bold>{usedLabel(pace)}</Text>
          </Box>
          <Text color={color}>{`${tone ? MARK[tone] : '○'} ${verdictOf(pace)}`}</Text>
          {wait && <Text dimColor>{`· ${wait}`}</Text>}
          {button}
        </Box>
        {target && (
          <Box flexDirection="row" gap={1}>
            <Box width={LABEL_CELLS}>
              <Text dimColor>Target</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={PLAIN}>{target.filled}</Text>
              <Text dimColor>{target.rest}</Text>
            </Box>
            <Box width={VALUE_CELLS} justifyContent="flex-end">
              <Text dimColor>{targetLabel(pace)}</Text>
            </Box>
            <Text dimColor>{meta.join(' · ')}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
