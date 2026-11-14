/**
 * `react-router` shim — the host has no URL router, so it gets a REAL in-memory
 * location instead of a dropped call.
 *
 * The mirrored Capabilities tree was written for hermes' react-router app: the
 * tab lives in `?tab=` (`app/hooks/use-route-enum-param.ts`), the MCP editor
 * deep-links with `?section=`, the settings panels jump to `/settings?tab=…`.
 * The host is a dockview workspace, so there is no browser history to push —
 * but "no history" must not mean "tab clicks do nothing".
 *
 * The first version of this file returned an empty location and DROPPED every
 * `navigate` with a console warning. Consequence, measured in the running app:
 * clicking 工具集 / 插件 / Connectors never left the skills tab, because
 * `useRouteEnumParam` writes the tab through `navigate` and the write vanished.
 * That is a functional bug, not a missing feature.
 *
 * So: one module-level location store, one subscription, and the three hooks
 * read/write it. It is not a fake router — there is no history array and no
 * pretend back/forward; `navigate` merges the target into the current location
 * exactly the way react-router's `replace` does, and components re-render.
 *
 * `push` and `replace` behave identically (nothing keeps a stack). A caller that
 * genuinely needs back/forward would need a real history, and none does today.
 */

import { useSyncExternalStore } from 'react'

export interface ShimLocation {
  hash: string
  key: string
  pathname: string
  search: string
  state: null
}

const INITIAL_LOCATION: ShimLocation = { hash: '', key: 'default', pathname: '/', search: '', state: null }

let location: ShimLocation = INITIAL_LOCATION
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  return () => void listeners.delete(listener)
}

function getSnapshot(): ShimLocation {
  return location
}

export function useLocation(): ShimLocation {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export type NavigateTarget = string | { hash?: string; pathname?: string; search?: string }
export type NavigateOptions = { replace?: boolean; state?: unknown }
export type NavigateFunction = (to: NavigateTarget, options?: NavigateOptions) => void

/** Split a URL-ish string into pathname / search / hash, the way react-router
 *  does: `?` and `#` only start a query or a hash. */
function splitTarget(to: string): Pick<ShimLocation, 'hash' | 'pathname' | 'search'> {
  let rest = to
  let hash = ''

  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) {
    hash = rest.slice(hashAt)
    rest = rest.slice(0, hashAt)
  }

  let search = ''
  const queryAt = rest.indexOf('?')
  if (queryAt >= 0) {
    search = rest.slice(queryAt)
    rest = rest.slice(0, queryAt)
  }

  return { hash, pathname: rest, search }
}

export function navigateTo(to: NavigateTarget): void {
  const next: ShimLocation =
    typeof to === 'string'
      ? { ...location, ...splitTarget(to) }
      : {
          ...location,
          hash: to.hash ?? location.hash,
          pathname: to.pathname ?? location.pathname,
          search: to.search ?? location.search
        }

  if (
    next.hash === location.hash &&
    next.pathname === location.pathname &&
    next.search === location.search
  ) {
    return
  }

  location = { ...next, key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  emit()
}

export function useNavigate(): NavigateFunction {
  // `replace` and `push` are the same here: nothing keeps a stack (see header).
  return navigateTo
}

export type SearchParamsInit = URLSearchParams | Record<string, string | string[]> | string | [string, string][]
export type SetSearchParams = (
  next: SearchParamsInit | ((prev: URLSearchParams) => SearchParamsInit),
  options?: NavigateOptions
) => void

function toParams(init: SearchParamsInit): URLSearchParams {
  if (init instanceof URLSearchParams) return init
  if (typeof init === 'string') return new URLSearchParams(init)
  if (Array.isArray(init)) return new URLSearchParams(init)

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(init)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item)
    else params.set(key, value)
  }
  return params
}

export function useSearchParams(): [URLSearchParams, SetSearchParams] {
  const current = useLocation()
  const params = new URLSearchParams(current.search)

  const setParams: SetSearchParams = (next, _options) => {
    const resolved = typeof next === 'function' ? next(new URLSearchParams(location.search)) : next
    const qs = toParams(resolved).toString()
    navigateTo({ search: qs ? `?${qs}` : '' })
  }

  return [params, setParams]
}

/** Test/teardown helper: return to the initial location. */
export function resetShimLocation(): void {
  location = INITIAL_LOCATION
  emit()
}
