/** Virtual ms as seconds, e.g. `12.345 s`. */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`

/** First block of a UUID, enough to tell rows apart. */
export const short = (id: string) => id.slice(0, 8)
