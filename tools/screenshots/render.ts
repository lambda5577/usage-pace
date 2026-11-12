// Renders the README's pictures of the bars view: the mod's own pace maths and its own
// drawing code (hooks/pace.ts, hooks/art.ts), set in a copy of the desktop app's band
// above the prompt, for several states of the week. Nothing here reads real usage.
//
//   TZ=Europe/Amsterdam PLAYWRIGHT=/path/to/node_modules/playwright-core node tools/screenshots/render.ts
//
// Needs Node 22.18 or newer (it runs the TypeScript as it is) and Playwright with its
// Chromium. FONT_DIR may name a folder with segoeui.ttf and seguisb.ttf (Windows' own
// fonts, which the desktop app draws with on Windows); without it a system sans is used.

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { card } from '../../plugins/usage-pace/hooks/art.ts'
import { DAYS, altOf, metaOf, paceOf, targetLabel, toneOf, usedLabel, verdictOf, waitOf } from '../../plugins/usage-pace/hooks/pace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'docs', 'images')
const HOUR = 3_600_000
// What the mod gives its picture in a band this wide (register.tsx: columns × 7.5 px, less the button).
const BAND_PX = 768
const CARD_PX = 690
// The week resets on a Tuesday at 14:00 on this machine's clock.
const RESETS_AT = new Date(2026, 10, 17, 14, 0).getTime()

type State = { file: string; title: string; hoursLeft: number; used: number | ((target: number) => number); readHoursAgo?: number }

const STATES: State[] = [
  { file: 'under-target', title: 'Under target', hoursLeft: 5 * 24 + 4, used: 20 },
  { file: 'on-target', title: 'On target', hoursLeft: 3 * 24 + 9, used: target => target },
  { file: 'over-target', title: 'A little over target', hoursLeft: 4 * 24 + 2, used: target => target + 6 },
  { file: 'far-over-target', title: 'Far over target', hoursLeft: 2 * 24 + 15, used: target => target + 21 },
  { file: 'limit-reached', title: 'Weekly limit reached', hoursLeft: 30, used: 100 },
  { file: 'old-reading', title: 'An older reading', hoursLeft: 4 * 24 + 18, used: 31, readHoursAgo: 3 },
]

/** The mod's bars picture for one state, as an SVG text and the words a screen reader gets. */
function bars(state: State): { svg: string; alt: string } {
  const now = RESETS_AT - state.hoursLeft * HOUR
  const probe = paceOf({ percentUsed: 0, resetsAt: new Date(RESETS_AT).toISOString(), at: now }, now)!
  const used = typeof state.used === 'number' ? state.used : state.used(probe.target!)
  const reading = { percentUsed: used, resetsAt: new Date(RESETS_AT).toISOString(), at: now - (state.readHoursAgo ?? 0) * HOUR }
  const pace = paceOf(reading, now)!
  const art = card({ meta: metaOf(pace, reading, now), verdict: verdictOf(pace), wait: waitOf(pace), tone: toneOf(pace), used: pace.used, usedLabel: usedLabel(pace), target: pace.target, targetLabel: targetLabel(pace), days: DAYS }, CARD_PX)

  return { svg: art.source, alt: altOf(pace, reading, now) }
}

// Built into the page: a page set from a string may not load fonts from files.
const fontFace = (file: string, weight: string) =>
  `@font-face { font-family: 'Segoe UI'; src: url(data:font/ttf;base64,${readFileSync(join(process.env.FONT_DIR!, file)).toString('base64')}); font-weight: ${weight}; }`
const fonts = process.env.FONT_DIR ? fontFace('segoeui.ttf', '400 500') + fontFace('seguisb.ttf', '600 700') : ''

// The desktop app's prompt area, its colors read from a screenshot of it in the dark theme.
const STYLE = `${fonts}
  * { box-sizing: border-box; }
  body { margin: 0; background: #191919; font-family: 'Segoe UI', system-ui, sans-serif; }
  .frame { width: ${BAND_PX + 48}px; padding: 20px 24px 14px; background: #191919; }
  .band { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #252525; border-radius: 12px; padding: 7px 8px 7px 12px; }
  .band svg { display: block; }
  .refresh { width: 32px; height: 32px; border-radius: 8px; background: #454545; display: grid; place-items: center; flex: none; }
  .prompt { margin-top: 8px; height: 44px; border-radius: 12px; background: #303030; display: flex; align-items: center; gap: 14px; padding: 0 16px; color: #8f8e88; font-size: 15px; }
  .prompt .plus { color: #e8e7e1; font-size: 22px; font-weight: 300; line-height: 1; }
  .prompt .grow { flex: 1; }
  .footer { margin-top: 10px; display: flex; justify-content: flex-end; gap: 14px; color: #e8e7e1; font-size: 13px; padding-right: 8px; }
  .footer .dim { color: #8f8e88; }
  .stack { display: flex; flex-direction: column; gap: 10px; }
  .caption { color: #8f8e88; font-size: 12px; margin: 0 0 4px 4px; }
`

const REFRESH = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#f2f1ec" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 6.6A5.4 5.4 0 1 0 13 10"/><path d="M13.6 2.8v3.9H9.7"/></svg>`
const MIC = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#e8e7e1" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>`

const band = (svg: string) => `<div class="band">${svg}<div class="refresh">${REFRESH}</div></div>`

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="frame">${body}</div></body></html>`

/** One state in the app's prompt area: the band, the prompt box under it and the footer. */
const scene = (svg: string) =>
  page(`${band(svg)}<div class="prompt"><span class="plus">+</span><span class="grow">Type / for commands</span>${MIC}</div><div class="footer"><span>Opus 5.5</span><span class="dim">High</span></div>`)

/** Every state's band, one under the other, each named. */
const overview = (shots: { title: string; svg: string }[]) =>
  page(`<div class="stack">${shots.map(shot => `<div><p class="caption">${shot.title}</p>${band(shot.svg)}</div>`).join('')}</div>`)

const playwright = await import(process.env.PLAYWRIGHT ?? 'playwright-core')
const chromium = playwright.chromium ?? playwright.default.chromium
const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: BAND_PX + 48, height: 200 }, deviceScaleFactor: 2 })

async function shoot(html: string, file: string): Promise<void> {
  await tab.setContent(html)
  await tab.evaluate(() => document.fonts.ready)
  await tab.locator('.frame').screenshot({ path: join(OUT, file) })
}

mkdirSync(OUT, { recursive: true })
const shots = STATES.map(state => ({ ...state, ...bars(state) }))
for (const shot of shots) {
  await shoot(scene(shot.svg), `${shot.file}.png`)
}
await tab.setViewportSize({ width: BAND_PX + 48, height: 800 })
await shoot(overview(shots), 'all-states.png')
await browser.close()
console.log(`Wrote ${shots.length + 1} pictures to ${OUT}`)
