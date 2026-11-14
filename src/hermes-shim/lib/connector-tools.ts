/**
 * @/lib/connector-tools shim - connector naming helpers.
 *
 * Upstream this module serves hermes hosted connectors (Nous accounts): slugs
 * like gmail map to Composio logos and connector/gmail/send_email tool names.
 * pi MCP tools are named <server>__<tool> by the engine, so only the two pure
 * helpers the capabilities tree imports are needed - behaviour kept verbatim,
 * pointed at pi naming.
 */

/** Upstream pulls brand art from Composio logo service, keyed by hosted-connector
 *  slugs pi does not have; an MCP server named gmail still gets its logo, and any
 *  other name gets the same deterministic host. */
export const connectorIconUrl = (slug: string): string => 'https://logos.composio.dev/api/' + slug

/** gmail_send_email -> "Gmail - Send Email" (upstream title casing). */
export function connectorTitle(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, ' ').trim()
  if (!cleaned) {
    return slug
  }

  return cleaned.replace(/\b\w/g, c => c.toUpperCase())
}
