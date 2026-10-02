import { useSyncExternalStore } from 'react'

export interface CartItem {
  eventId: string
  name: string
  price: number
  quantity: number
  /** Idempotency-Key for this checkout; regenerated whenever the quantity changes. */
  key: string
}

export interface CartState {
  email: string
  items: CartItem[]
}

const STORAGE_KEY = 'supertickets.cart'
const empty: CartState = { email: '', items: [] }

function load(): CartState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as CartState
      if (Array.isArray(parsed.items)) return { email: parsed.email ?? '', items: parsed.items }
    }
  } catch {
    // unavailable or corrupt storage: start empty
  }
  return empty
}

let state: CartState = load()
const listeners = new Set<() => void>()

function set(next: CartState) {
  state = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // keep the in-memory cart
  }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useCart = () => useSyncExternalStore(subscribe, () => state)

export const clampQuantity = (q: number) => Math.min(10, Math.max(1, Math.trunc(q) || 1))

export function addToCart(item: Omit<CartItem, 'key'>) {
  const quantity = clampQuantity(item.quantity)
  const existing = state.items.find((i) => i.eventId === item.eventId)
  const key = crypto.randomUUID()
  set({
    ...state,
    items: existing
      ? state.items.map((i) => (i.eventId === item.eventId ? { ...i, quantity, key } : i))
      : [...state.items, { ...item, quantity, key }],
  })
}

export function setQuantity(eventId: string, quantity: number) {
  const q = clampQuantity(quantity)
  set({
    ...state,
    items: state.items.map((i) =>
      i.eventId === eventId && i.quantity !== q ? { ...i, quantity: q, key: crypto.randomUUID() } : i,
    ),
  })
}

export const removeFromCart = (eventId: string) =>
  set({ ...state, items: state.items.filter((i) => i.eventId !== eventId) })

export const setEmail = (email: string) => set({ ...state, email })
