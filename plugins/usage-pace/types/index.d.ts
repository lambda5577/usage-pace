/** The last reading of the weekly limit: the `seven_day` rate-limit window. */
export type Reading = {
  /** How much of the week's limit is used, 0 to 100. */
  percentUsed: number
  /** When the week resets, ISO 8601; empty when the reading named no time. */
  resetsAt: string
  /** When it was read, in `$.clock.now()`'s milliseconds. */
  at: number
}

/** How the mod shows: `label`, one line of figures under the prompt, or `bars`, two bars above it. */
export type View = 'label' | 'bars'

declare module 'claude-code' {
  interface PluginState {
    'usage-pace': {
      reading: Reading | null
      view: View
      /** True while the bars view's refresh button has its request out. */
      isRefreshing: boolean
    }
  }
}
