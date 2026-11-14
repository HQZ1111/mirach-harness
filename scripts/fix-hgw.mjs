import { readFileSync, writeFileSync } from 'node:fs'

const p = 'src/hermes-shim/hermes.ts'
let t = readFileSync(p, 'utf8')

const before = t

// HermesGateway: the mirrored MCP code threads it into reload helpers that call
// `request`; keep the surface it touches.
t = t.replace(
  `export interface HermesGateway {
  readonly connectionState: 'closed' | 'open'
}`,
  `export interface HermesGateway {
  readonly connectionState: 'closed' | 'open'
  request: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<T>`
)

// getHermesConfigRecord: the i18n provider passes (undefined, {includeDefaults}).
t = t.replace(
  'export async function getHermesConfigRecord(profile?: ProfileScope): Promise<HermesConfigRecord> {',
  `export async function getHermesConfigRecord(
  profile?: ProfileScope,
  _options?: { includeDefaults?: boolean }
): Promise<HermesConfigRecord> {`
)

// saveHermesConfig: the i18n provider passes (config, undefined, {preserveLanguage}).
t = t.replace(
  'export async function saveHermesConfig(patch: HermesConfigRecord, profile?: ProfileScope): Promise<{ ok: boolean }> {',
  `export async function saveHermesConfig(
  patch: HermesConfigRecord,
  profile?: ProfileScope,
  _options?: { preserveLanguage?: boolean }
): Promise<{ ok: boolean }> {`
)

writeFileSync(p, t, 'utf8')
console.log('changed =', t !== before)
