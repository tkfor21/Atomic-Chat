/**
 * Decision catalog registry — remote configuration loader.
 *
 * The decision models the app offers (laya checkpoints the TurboQuant
 * `llama-server --decision` converts and serves) live in
 * `AtomicBot-ai/atomic-chat-conf/models/decision.json`. Fetched at runtime,
 * cached for an hour, backed by a generated snapshot
 * ({@link BASELINE_DECISION_CATALOG}) for the offline first launch.
 *
 * Same architecture as `diffusion-catalog-registry.ts`, isolated from it (own
 * cache keys, URL and schema). Parsing is strict: every file path becomes a
 * download URL and a path under `<data>/decision/models/<id>`, so a manifest
 * must not be able to climb out of that folder, and every file carries the
 * size and sha256 the downloader verifies.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import { BASELINE_DECISION_CATALOG } from './decision-catalog-baseline'

export const DEFAULT_DECISION_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/decision.json'

export const DECISION_CATALOG_URL: string =
  (import.meta.env.VITE_DECISION_CATALOG_URL as string | undefined) ??
  DEFAULT_DECISION_CATALOG_URL

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches the other registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'atomic_decision_catalog_cache_v1'
const CACHE_TS_KEY = 'atomic_decision_catalog_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

/** Files the engine needs to convert a checkpoint folder; a model without one is dropped. */
export const REQUIRED_DECISION_FILES = [
  'model.safetensors',
  'rl_agent_config.json',
  'encoder/config.json',
  'tokenizer/tokenizer.json',
] as const

export type DecisionCatalogFile = {
  /** Path inside the repo and inside the model folder. */
  path: string
  bytes: number
  sha256: string
}

export type DecisionCatalogModel = {
  id: string
  name: string
  description?: string
  repo: string
  /** The commit every file is downloaded from. */
  revision: string
  backbone?: string
  params?: string
  /** `multilingual` or a two-letter language code. */
  languages: string
  context: number
  /** Whether the router (`/v1/router/score`) has a calibration. */
  calibrated: boolean
  license?: string
  default?: boolean
  /** The oldest TurboQuant release that converts and serves it, `b<build>-<semver>`. */
  min_engine?: string
  /** About the size of the GGUF the engine converts the checkpoint into. */
  gguf_cache_bytes?: number
  files: DecisionCatalogFile[]
}

export type DecisionCatalog = {
  schema_version: number
  updated_at: string
  models: DecisionCatalogModel[]
}

export type DecisionCatalogSource = 'remote' | 'cache' | 'baseline'

export type DecisionCatalogFetchResult = {
  catalog: DecisionCatalog
  source: DecisionCatalogSource
  fetchedAt: number | null
  error?: string
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REVISION_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const LANGUAGES_RE = /^(multilingual|[a-z]{2})$/
const MIN_ENGINE_RE = /^b[0-9]+-[0-9]+\.[0-9]+\.[0-9]+$/
const PATH_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * A file path is safe when every segment is a plain name (no `.`, `..` or
 * empty segment) and it is not a root `config.json`: with one, the engine
 * reads the folder as a plain Hugging Face model instead of a laya checkpoint.
 */
export const isSafeDecisionFilePath = (value: string): boolean =>
  PATH_RE.test(value) &&
  value !== 'config.json' &&
  value.split('/').every((segment) => segment !== '.' && segment !== '..')

const sanitizeFile = (raw: unknown): DecisionCatalogFile | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.path !== 'string' || !isSafeDecisionFilePath(raw.path))
    return null
  if (!isPositiveInt(raw.bytes)) return null
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return null
  return { path: raw.path, bytes: raw.bytes, sha256: raw.sha256 }
}

/**
 * Strip unknown keys and reject a model that could not be downloaded or
 * converted as written: a malformed id, repo or revision, a file without its
 * size or hash, a duplicate path, or a missing required file.
 */
export const sanitizeDecisionModel = (
  raw: unknown
): DecisionCatalogModel | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) return null
  if (typeof raw.revision !== 'string' || !REVISION_RE.test(raw.revision))
    return null
  if (typeof raw.languages !== 'string' || !LANGUAGES_RE.test(raw.languages))
    return null
  if (!isPositiveInt(raw.context)) return null
  if (typeof raw.calibrated !== 'boolean') return null
  if (!Array.isArray(raw.files)) return null

  const files: DecisionCatalogFile[] = []
  const paths = new Set<string>()
  for (const entry of raw.files) {
    const file = sanitizeFile(entry)
    if (!file || paths.has(file.path)) return null
    paths.add(file.path)
    files.push(file)
  }
  if (!REQUIRED_DECISION_FILES.every((path) => paths.has(path))) return null

  const description = optionalString(raw.description)
  const backbone = optionalString(raw.backbone)
  const params = optionalString(raw.params)
  const license = optionalString(raw.license)
  const minEngine =
    typeof raw.min_engine === 'string' && MIN_ENGINE_RE.test(raw.min_engine)
      ? raw.min_engine
      : undefined
  return {
    id: raw.id,
    name: raw.name,
    ...(description ? { description } : {}),
    repo: raw.repo,
    revision: raw.revision,
    ...(backbone ? { backbone } : {}),
    ...(params ? { params } : {}),
    languages: raw.languages,
    context: raw.context,
    calibrated: raw.calibrated,
    ...(license ? { license } : {}),
    ...(raw.default === true ? { default: true } : {}),
    ...(minEngine ? { min_engine: minEngine } : {}),
    ...(isPositiveInt(raw.gguf_cache_bytes)
      ? { gguf_cache_bytes: raw.gguf_cache_bytes }
      : {}),
    files,
  }
}

const isCatalogShape = (
  value: unknown
): value is { schema_version: number; updated_at: string; models: unknown[] } =>
  isRecord(value) &&
  typeof value.schema_version === 'number' &&
  typeof value.updated_at === 'string' &&
  Array.isArray(value.models)

/**
 * Parse an untrusted payload into a catalog, or throw when it is not one.
 * Invalid models are dropped (and logged); a payload with no usable model is
 * rejected so the caller falls back.
 */
export const parseDecisionCatalog = (data: unknown): DecisionCatalog => {
  if (!isCatalogShape(data)) {
    throw new Error('Decision catalog payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Decision catalog schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }
  const models: DecisionCatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of data.models) {
    const model = sanitizeDecisionModel(raw)
    if (!model) {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?'
      console.warn(`[decision-catalog-registry] Dropping invalid model ${id}`)
      continue
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) {
    throw new Error('Decision catalog carries no usable model')
  }
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    models,
  }
}

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export type CachedDecisionCatalog = {
  catalog: DecisionCatalog
  fetchedAt: number
}

export const getCachedDecisionCatalog = (): CachedDecisionCatalog | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    // Re-validated on read: the rules can tighten between releases.
    return { catalog: parseDecisionCatalog(JSON.parse(raw)), fetchedAt }
  } catch {
    return null
  }
}

export const isDecisionCatalogCacheFresh = (
  cached: CachedDecisionCatalog | null
): boolean => cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS

const writeCache = (catalog: DecisionCatalog, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(catalog))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[decision-catalog-registry] Failed to write cache:', error)
  }
}

export const clearDecisionCatalogCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[decision-catalog-registry] Failed to clear cache:', error)
  }
}

const isTauriRuntime = (): boolean => {
  try {
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI)
  } catch {
    return false
  }
}

const fetchOnce = async (
  fetcher: typeof fetch,
  url: string,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `Decision catalog fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchCatalog = async (
  url: string,
  signal?: AbortSignal
): Promise<DecisionCatalog> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[decision-catalog-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }
  return parseDecisionCatalog(data)
}

/** Tauri's HTTP plugin does not always honour `AbortSignal`; a timer guarantees resolution. */
const withHardTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Decision catalog fetch timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })

export type DecisionCatalogFetchOptions = {
  /** Bypass the cache freshness check and force a network round-trip. */
  force?: boolean
  /** Override URL (for tests). */
  url?: string
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/** The bundled snapshot, re-validated so a stale generator cannot ship junk. */
export const getBaselineDecisionCatalog = (): DecisionCatalog =>
  parseDecisionCatalog(BASELINE_DECISION_CATALOG)

/**
 * Resolve the catalog: fresh cache (unless forced), then the network (cached
 * on success), then a stale cache, then the bundled snapshot. Never throws.
 */
export const fetchDecisionCatalog = async (
  options: DecisionCatalogFetchOptions = {}
): Promise<DecisionCatalogFetchResult> => {
  const {
    force = false,
    url = DECISION_CATALOG_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedDecisionCatalog()
  if (!force && isDecisionCatalogCacheFresh(cached) && cached) {
    return { catalog: cached.catalog, source: 'cache', fetchedAt: cached.fetchedAt }
  }

  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    const catalog = await withHardTimeout(
      fetchCatalog(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(catalog, fetchedAt)
    return { catalog, source: 'remote', fetchedAt }
  } catch (error) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown decision catalog error'
    console.warn('[decision-catalog-registry] Falling back:', message)
    if (cached) {
      return {
        catalog: cached.catalog,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return {
      catalog: getBaselineDecisionCatalog(),
      source: 'baseline',
      fetchedAt: null,
      error: message,
    }
  }
}

/** Where a model's file is downloaded from: the pinned revision, never a branch. */
export const decisionFileUrl = (
  model: DecisionCatalogModel,
  file: DecisionCatalogFile
): string =>
  `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`

/** Bytes of the checkpoint on disk. */
export const decisionCheckpointBytes = (model: DecisionCatalogModel): number =>
  model.files.reduce((sum, file) => sum + file.bytes, 0)

/** Disk the model takes once it ran: the checkpoint plus the GGUF the engine converts it into. */
export const decisionDiskBytes = (model: DecisionCatalogModel): number =>
  decisionCheckpointBytes(model) + (model.gguf_cache_bytes ?? 0)
