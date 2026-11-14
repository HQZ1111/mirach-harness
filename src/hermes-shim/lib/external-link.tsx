/**
 * @/lib/external-link shim - the outbound link surface.
 *
 * Upstream a 477-line module: URL normalization, title fetching through the
 * Electron bridge, brand favicons, and three link components. The capabilities
 * tree imports openExternalLink (connector "open provider" actions) and the
 * ExternalLink component (catalog detail links). Both route through the host
 * openExternal bridge member, which bridge.ts wires to pi's shell opener.
 */

import { type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/hermes-shim/lib/utils'

/** Open a URL outside the app. Delegates to the bridge's openExternal. */
export function openExternalLink(href: string): void {
  void window.hermesDesktop?.openExternal?.(href)
}

export interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  /** Show the external-link glyph after the label (upstream default). */
  showExternalIcon?: boolean
  children?: ReactNode
}

/** An anchor that always opens outside the app (upstream behaviour). */
export function ExternalLink({ children, className, href, showExternalIcon = true, ...rest }: ExternalLinkProps) {
  return (
    <a
      className={cn('wrap-break-word', className)}
      href={href}
      onClick={event => {
        event.preventDefault()
        openExternalLink(href)
      }}
      rel="noreferrer noopener"
      target="_blank"
      title={href}
      {...rest}
    >
      {children}
      {showExternalIcon && <span aria-hidden> ↗</span>}
    </a>
  )
}
