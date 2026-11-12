import type { Reading } from '../types'

export const DAYS = 7
const HOURS = DAYS * 24
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
// A reading older than this says how old it is: usage elsewhere has not reached it.
const OLD_MS = 30 * MINUTE_MS
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** How the used figure stands against the target: on or under it, a little over, or far over. */
export type Tone = 'good' | 'warning' | 'critical'

export type Pace = {
  used: number
  /** Where an even pace stands at the end of the hour now running, 0 to 100; null when the reset time is unknown. */
  target: number | null
  /** Which of the week's 24-hour days this is, 1 to 7, counted from the last reset. */
  day: number | null
  /** How long until the week resets. */
  leftMs: number | null
  /** When the week resets, to the minute. */
  resetsAt: number | null
  /** How long until the target reaches the used figure, with nothing more used; null when it already has. */
  catchUpMs: number | null
}

const clamp = (percent: number) => Math.max(0, Math.min(100, percent))

const whole = (percent: number) => `${Math.round(percent)}%`

/**
 * The one of two readings that says more about the week: of a later week first, then the
 * one read last, `found` on a tie. Not the fuller one: a weekly reset, once used, empties
 * the week and keeps its reset time, so a lower figure read later is the truth.
 *
 * So a session that sat idle never puts its old figure over a newer one from elsewhere:
 * its figure was read earlier, and one of unknown age is read at 0.
 */
export function latest(held: Reading | null, found: Reading): Reading {
  if (!held) return found

  const [heldReset, foundReset] = [Date.parse(held.resetsAt), Date.parse(found.resetsAt)]
  // The same week's reset comes a second apart in different readings; another week's, days.
  if (Math.abs(heldReset - foundReset) > HOUR_MS) return heldReset > foundReset ? held : found

  return held.at > found.at ? held : found
}

/**
 * The week's limit out of what the desktop app's usage card reports, as read at `at`: the
 * window labelled weekly for all models, or the first weekly one; null when it shows none.
 */
export function weekOfPlan(card: unknown, at: number): Reading | null {
  const windows = (card as { plan?: { windows?: unknown } } | null)?.plan?.windows
  if (!Array.isArray(windows)) return null

  const weekly = windows.filter((each): each is { label: string; percentUsed: number; resetsAt?: unknown } => typeof each?.label === 'string' && /^weekly/i.test(each.label) && typeof each.percentUsed === 'number')
  const week = weekly.find(each => /all models/i.test(each.label)) ?? weekly[0]

  return week ? { percentUsed: week.percentUsed, resetsAt: typeof week.resetsAt === 'string' ? week.resetsAt : '', at } : null
}

/** A stretch of time in its two largest units: `3d 22h`, `5h 12m`, `8m`. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`

  return `${minutes}m`
}

/** How long ago, in its one largest unit: `2d`, `3h`, `40m`. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`

  return `${minutes}m`
}

/** A moment as its weekday and time on this machine's clock: `Tue 15:00`. */
export function formatMoment(ms: number): string {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')

  return `${WEEKDAYS[date.getDay()]} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/**
 * Where the week stands at `now`, or null when the week the reading speaks of is over.
 *
 * The week is seven 24-hour days from its last reset, and an even pace spends the same
 * share of the limit in each of its 168 hours; the target is what that pace has used by
 * the end of the hour now running, so it steps up once an hour, a seventh a day in all.
 */
export function paceOf(reading: Reading, now: number): Pace | null {
  const used = clamp(reading.percentUsed)
  // To the minute: one source says 13:00:00, another 12:59:59.7, of the same reset.
  const resetsAt = Math.round(Date.parse(reading.resetsAt) / MINUTE_MS) * MINUTE_MS
  if (Number.isNaN(resetsAt)) return { used, target: null, day: null, leftMs: null, resetsAt: null, catchUpMs: null }
  if (resetsAt <= now) return null

  const leftMs = resetsAt - now
  const elapsed = Math.max(0, DAYS * DAY_MS - leftMs)
  const day = Math.min(DAYS, Math.floor(elapsed / DAY_MS) + 1)
  const hour = Math.min(HOURS, Math.floor(elapsed / HOUR_MS) + 1)
  // The first of the week's hours whose target covers what is used: the target reaches
  // the used figure as that hour begins.
  const covering = Math.min(HOURS, Math.ceil((used * HOURS) / 100))
  const catchUpMs = covering > hour ? (covering - 1) * HOUR_MS - elapsed : null

  return { used, target: (hour * 100) / HOURS, day, leftMs, resetsAt, catchUpMs }
}

/**
 * The used figure's tone, or null where no target says: over the target by a full day's
 * share, or with the week's limit spent, it is critical; over it by less, a warning.
 */
export function toneOf(pace: Pace): Tone | null {
  if (pace.used >= 100) return 'critical'
  if (pace.target === null) return null

  const over = pace.used - pace.target
  if (over >= 100 / DAYS) return 'critical'

  return over >= 0.5 ? 'warning' : 'good'
}

/** The used figure. `54%`. */
export const usedLabel = (pace: Pace) => whole(pace.used)

/** The target figure; empty where no target says. `57%`. */
export const targetLabel = (pace: Pace) => (pace.target === null ? '' : whole(pace.target))

/** The label view after its used figure: the target and the time left in the week. `/ 57% · 3d 16h`. */
export const restLabel = (pace: Pace) => (pace.target === null || pace.leftMs === null ? '' : `/ ${whole(pace.target)} · ${formatSpan(pace.leftMs)}`)

/** The label view as one text: used over target, then the time left. `54% / 57% · 3d 16h`. */
export const labelOf = (pace: Pace) => [usedLabel(pace), restLabel(pace)].filter(Boolean).join(' ')

/** The bars view's verdict: how far the used figure is from the target, in words. */
export function verdictOf(pace: Pace): string {
  if (pace.used >= 100) return 'Weekly limit reached'
  if (pace.target === null) return 'Reset time unknown'

  const over = pace.used - pace.target
  if (over >= 0.5) return `${whole(over)} over target`
  if (over > -0.5) return 'On target'

  return `${whole(-over)} under target`
}

/**
 * The bars view's word on the way back, said beside an over-target verdict: how long, with
 * nothing more used, until the target has caught up. In whole hours, rounded up, since
 * the target moves once an hour; empty when not over target.
 */
export function waitOf(pace: Pace): string {
  if (pace.catchUpMs === null || pace.target === null || pace.used >= 100 || pace.used - pace.target < 0.5) return ''

  const wait = pace.catchUpMs >= HOUR_MS ? `${Math.ceil(pace.catchUpMs / HOUR_MS)}h` : `${Math.max(1, Math.ceil(pace.catchUpMs / MINUTE_MS))}m`

  return `on target in ${wait}`
}

/** The bars view's notes on where the week stands, the ones that matter most first: a narrow band drops from the end. */
export function metaOf(pace: Pace, reading: Reading, now: number): string[] {
  const parts: string[] = []
  if (pace.day !== null) parts.push(`Day ${pace.day}/${DAYS}`)
  if (pace.leftMs !== null) parts.push(`${formatSpan(pace.leftMs)} left`)
  if (pace.resetsAt !== null) parts.push(`resets ${formatMoment(pace.resetsAt)}`)
  if (now - reading.at >= OLD_MS) parts.push(`read ${formatAge(now - reading.at)} ago`)

  return parts
}

/** The bars view in words, for a reader that cannot see the bars. */
export function altOf(pace: Pace, reading: Reading, now: number): string {
  const target = pace.target === null ? '' : `, target ${whole(pace.target)} by now`

  return `Weekly limit: ${whole(pace.used)} used${target}. ${[...metaOf(pace, reading, now), verdictOf(pace), waitOf(pace)].filter(Boolean).join('. ')}.`
}
