/** Seeded PRNG (mulberry32): every random choice in the lab goes through it, so a seed replays exactly. */
export interface Rng {
  /** [0, 1) */
  next(): number
  /** UUID-shaped id. */
  uuid(): string
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('')
  return {
    next,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(next() * 4)]}${hex(3)}-${hex(12)}`,
  }
}
