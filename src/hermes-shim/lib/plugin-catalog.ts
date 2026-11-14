/**
 * @/lib/plugin-catalog shim - the public catalog origin.
 *
 * Upstream points the browser at hermes-agent.nousresearch.com, whose
 * docs/api/{skills,plugins}.json snapshots feed the Skills Hub and the plugin
 * catalog. Those snapshots are hermes own curated registry - skills and plugins
 * written for hermes runtime, with requiresHermes gates.
 *
 * Host (user decision 2026-10-27): point the same browser surface at the awesome
 * lists instead - community-maintained GitHub indexes that anyone can read and
 * that pi skills (plain SKILL.md directories) can actually be sourced from. The
 * catalog-data fetch in the mirror reads CATALOG_ORIGIN + /docs/api/<kind>.json,
 * so the docs host is swapped for the awesome repo and the doc links point at
 * those repositories.
 */

/** Base for catalog snapshots. The mirrored fetch appends /<kind>.json. */
export const CATALOG_ORIGIN = 'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main'

/** Where the "learn more" links go. */
export const PLUGIN_CATALOG_DOCS_URL = 'https://github.com/punkpeye/awesome-mcp-servers'
export const SKILLS_DOCS_URL = 'https://github.com/hesreallyhim/awesome-claude-code'
/** Upstream submit-a-mod PR link; the awesome lists take PRs the same way. */
export const SUBMIT_MOD_URL = 'https://github.com/hesreallyhim/awesome-claude-code/blob/main/CONTRIBUTING.md'

export const PLUGIN_CATALOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Upstream `lib/plugin-catalog.ts::PluginCatalogEntry` — the fields an install
 *  needs (the same ones the embedded picker posts on a pick). Copied field for
 *  field because `openCatalogPluginInstall` reads them by name. */
export interface PluginCatalogEntry {
  name: string
  repo: string
  /** Reviewed pin (40-hex) the backend installs at; may be missing on a malformed feed. */
  sha?: string
  /** Sub-directory of a monorepo the plugin lives in; empty when the repo root is the plugin. */
  subdir?: string
  /** The description's first sentence: what the plugin does, in one line. */
  summary?: string
  /** official / verified / community; badges the install dialog. */
  tier?: string
}

export type PluginCatalogLookupError = 'invalid_name' | 'unavailable' | 'unknown'

export type PluginCatalogLookup = { ok: false; error: PluginCatalogLookupError } | { ok: true; entry: PluginCatalogEntry }

/**
 * Upstream resolves a catalog NAME against the backend's live, pinned catalog.
 * The host's catalog is the awesome lists: they carry no per-name pin and no
 * backend lookup RPC, so a name cannot be resolved to a reviewed SHA. The honest
 * answer is `unavailable` — not a guess at a repo (rule 12).
 */
export async function lookupPluginCatalogEntry(name: string): Promise<PluginCatalogLookup> {
  if (!PLUGIN_CATALOG_NAME_RE.test(name)) {
    return { ok: false, error: 'invalid_name' }
  }

  return { ok: false, error: 'unavailable' }
}
