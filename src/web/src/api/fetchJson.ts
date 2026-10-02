import type { ProblemType } from './types'

/** RFC 9457 Problem Details as returned by the APIs. */
export interface ProblemDetails {
  type?: ProblemType | string
  title?: string
  status?: number
  detail?: string
  errors?: Record<string, string[]>
}

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }
}

export interface FetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
}

export async function fetchJson<T>(path: string, { body, headers, ...init }: FetchOptions = {}): Promise<T> {
  const h = new Headers(headers)
  if (body !== undefined) h.set('Content-Type', 'application/json')
  const res = await fetch(path, {
    ...init,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let problem: ProblemDetails = { status: res.status }
    try {
      problem = { ...problem, ...(await res.json()) }
    } catch {
      // non-JSON error body: keep the status-only problem
    }
    throw new ApiError(res.status, problem)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}
