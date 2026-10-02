const KEY = 'adminApiKey'

export function getApiKey(): string {
  try {
    return sessionStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setApiKey(value: string) {
  try {
    if (value) sessionStorage.setItem(KEY, value)
    else sessionStorage.removeItem(KEY)
  } catch {
    // storage unavailable: key lives only for this page view
  }
}
