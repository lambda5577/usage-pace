// The bars view as the desktop app draws it: the whole band is one SVG picture with no
// surface of its own, set straight on the app's band so no room goes to a frame. Its
// inks are for a dark app, which is the theme it is used in.

import type { Tone } from './pace'

export const INK = {
  // What is drawn inside a colored mark, where the mark's own color is the ground.
  onMark: '#1a1a19',
  text: '#ffffff',
  soft: '#c3c2b7',
  muted: '#898781',
  target: '#3987e5',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
} as const

export type Picture = { source: string; width: number; height: number }

export type Card = {
  /** What stands under the verdict, the parts that matter most first; the last are dropped where room runs out. */
  meta: readonly string[]
  verdict: string
  /** What follows the verdict on its line, in a quieter ink; empty for nothing. */
  wait: string
  /** How the used figure stands against the target; null where no target says. */
  tone: Tone | null
  used: number
  usedLabel: string
  target: number | null
  targetLabel: string
  days: number
}

const FONT = "Inter, 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
// Just enough at the sides that no letter is cut at the picture's edge.
const PAD = 2
const LABEL = 44
const VALUE = 36
const GAP = 12
const BAR = 6
// The middle of the first row, and how far under it the second one's is: two lines of
// text with nothing above, between or under them but what the letters need.
const TOP = 8.5
const ROW = 15
const ICON = 11
// The bars keep at least this much; the notes beside them give way first.
const MIN_BAR = 150
// Between the verdict and the wait said after it.
const WAIT_GAP = 5
// The gap between two days of a bar.
const DAY_GAP = 1.2
const FILL: Record<Tone, string> = { good: INK.good, warning: INK.warning, critical: INK.critical }

const fillOf = (tone: Tone | null) => (tone ? FILL[tone] : INK.target)

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const round = (value: number) => Math.round(value * 10) / 10

// The app's font is not known to a picture, so widths are estimated per character, set
// against what the app drew: within a few percent, and over rather than under, so the
// notes are given the room they take and little more.
const SPACE = / /
const NARROW = /[.,:;'|!iIl1()[\]{}tfjr/·-]/
const WIDE = /[A-HK-Zmw@%#&MW_]/

function widthOf(text: string, size: number, weight = 500): number {
  let em = 0
  for (const char of text) em += SPACE.test(char) ? 0.28 : NARROW.test(char) ? 0.33 : WIDE.test(char) ? 0.69 : 0.56

  return em * size * (weight >= 600 ? 1.05 : 1)
}

type Type = { size: number; fill: string; weight?: number; anchor?: 'end' }

const write = (x: number, y: number, text: string, type: Type) =>
  `<text x="${round(x)}" y="${round(y)}" font-family="${FONT}" font-size="${type.size}" font-weight="${type.weight ?? 500}" fill="${type.fill}"${type.anchor ? ` text-anchor="${type.anchor}"` : ''}>${escape(text)}</text>`

/** The mark beside the verdict, a shape of its own for each tone so the state never rests on color alone. */
function mark(tone: Tone | null, x: number, y: number): string {
  const ink = `fill="none" stroke="${INK.onMark}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`
  const at = `transform="translate(${round(x)} ${round(y)}) scale(${round(ICON / 13)})"`
  if (tone === 'good') return `<g ${at}><circle cx="6.5" cy="6.5" r="6.5" fill="${INK.good}"/><path d="M3.7 6.8l2 2 3.7-4.1" ${ink}/></g>`
  if (tone === 'warning') return `<g ${at}><path d="M6.5 .8l6.1 11.4H.4z" fill="${INK.warning}" stroke="${INK.warning}" stroke-width="1" stroke-linejoin="round"/><path d="M6.5 4.6v3.4M6.5 10.2v.1" ${ink}/></g>`
  if (tone === 'critical') return `<g ${at}><rect width="13" height="13" rx="3" fill="${INK.critical}"/><path d="M6.5 3.2v4.2M6.5 9.7v.1" fill="none" stroke="${INK.text}" stroke-width="1.8" stroke-linecap="round"/></g>`

  return `<g ${at}><circle cx="6.5" cy="6.5" r="5.6" fill="none" stroke="${INK.muted}" stroke-width="1.6"/></g>`
}

/**
 * What both bars are cut to: one piece per day with a gap between two, the picture's
 * height tall. The gaps are holes, not strokes, so whatever the app has behind shows.
 */
function daysClip(x: number, width: number, days: number, height: number): string {
  let pieces = ''
  for (let day = 0; day < days; day += 1) {
    const from = x + (width * day) / days + (day === 0 ? 0 : DAY_GAP / 2)
    const to = x + (width * (day + 1)) / days - (day === days - 1 ? 0 : DAY_GAP / 2)
    pieces += `<rect x="${round(from)}" y="0" width="${round(to - from)}" height="${height}"/>`
  }

  return `<clipPath id="days">${pieces}</clipPath>`
}

/** One meter: a track of the fill's own hue and the fill, cut into the week's days. */
function meter(x: number, y: number, width: number, percent: number, fill: string): string {
  const filled = percent <= 0 ? 0 : Math.max(BAR, (Math.min(100, percent) / 100) * width)
  let out = `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${BAR}" rx="${BAR / 2}" fill="${fill}" fill-opacity="0.22"/>`
  if (filled > 0) out += `<rect x="${round(x)}" y="${round(y)}" width="${round(filled)}" height="${BAR}" rx="${BAR / 2}" fill="${fill}"/>`

  return `<g clip-path="url(#days)">${out}</g>`
}

/**
 * The band, two lines of text tall: the used bar over the target bar, each with its
 * value, and beside them the verdict over the notes on where the week stands.
 */
export function card(card: Card, shownWidth: number): Picture {
  const width = Math.round(shownWidth)
  const hasTarget = card.target !== null
  const height = Math.round(TOP * 2 + (hasTarget ? ROW : 0))
  const barX = PAD + LABEL
  // What the bars and the notes beside them share.
  const room = width - PAD - barX - VALUE
  const verdictWidth = ICON + 5 + widthOf(card.verdict, 12, 600)
  const waitText = card.wait ? `· ${card.wait}` : ''
  const waitWidth = waitText ? WAIT_GAP + widthOf(waitText, 11.5) : 0

  // The notes give way before the bars do: the last notes under the verdict first, then
  // the wait beside it, then all of them.
  let meta = ''
  let wait = ''
  let notes = 0
  for (const kept of waitText ? [waitText, ''] : ['']) {
    for (let count = hasTarget ? card.meta.length : 0; count >= 0 && notes === 0; count -= 1) {
      const text = card.meta.slice(0, count).join(' · ')
      const wide = Math.max(verdictWidth + (kept ? waitWidth : 0), widthOf(text, 11.5))
      if (room - GAP - wide >= MIN_BAR) {
        meta = text
        wait = kept
        notes = wide
      }
    }
  }
  const barWidth = notes > 0 ? room - GAP - notes : room
  const valueRight = barX + barWidth + VALUE
  const notesX = valueRight + GAP

  const row = (middle: number, label: string, percent: number, fill: string, value: string, isMain: boolean) =>
    write(PAD, middle + 4, label, { size: 11.5, fill: INK.muted }) +
    meter(barX, middle - BAR / 2, barWidth, percent, fill) +
    write(valueRight, middle + 4.3, value, { size: 12.5, weight: isMain ? 600 : 500, fill: isMain ? INK.text : INK.soft, anchor: 'end' })

  let body = `<defs>${daysClip(barX, barWidth, card.days, height)}</defs>`
  body += row(TOP, 'Used', card.used, fillOf(card.tone), card.usedLabel, true)
  if (card.target !== null) body += row(TOP + ROW, 'Target', card.target, INK.target, card.targetLabel, false)
  if (notes > 0) {
    body += mark(card.tone, notesX, TOP - ICON / 2)
    // One line of text, so the renderer sets the wait right after the verdict whatever its font.
    const after = wait ? `<tspan dx="${WAIT_GAP}" font-size="11.5" font-weight="500" fill="${INK.muted}">${escape(wait)}</tspan>` : ''
    body += `<text x="${round(notesX + ICON + 5)}" y="${round(TOP + 4.2)}" font-family="${FONT}" font-size="12" font-weight="600" fill="${INK.text}">${escape(card.verdict)}${after}</text>`
    if (meta) body += write(notesX, TOP + ROW + 4, meta, { size: 11.5, fill: INK.muted })
  }

  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`, width, height }
}
