/**
 * Decision models on disk and in the core.
 *
 * A model is a laya checkpoint folder, downloaded file by file from its
 * pinned Hugging Face revision into `<dataFolder>/decision/models/<id>/`. The
 * core runs it with `llama-server --decision -m <folder>`: the engine converts
 * the folder once into `<dataFolder>/decision/gguf-cache` (the core prunes
 * that cache) and serves `/v1/systemone` behind the Local API Server.
 * Decision models never live under `llamacpp/models`: they are not chat
 * models and must not surface in the model picker or in `/v1/models`.
 */

import { fs } from '@janhq/core'

import { getServiceHub } from '@/hooks/useServiceHub'
import {
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  emitTransferValidationFailed,
  isTransferValidationError,
  sanitizeTaskId,
  transferFiles,
  type TransferItem,
} from '@/services/diffusion/transfer'
import {
  decisionFileUrl,
  type DecisionCatalogFile,
  type DecisionCatalogModel,
} from '@/services/decision-catalog-registry'
import type { DecisionConfig, DecisionStatus } from '@/services/decision/types'

export const DECISION_MODELS_DIR = 'decision/models'

/** The folder the core is pointed at; relative, the core resolves it against the data folder. */
export const decisionModelDir = (id: string): string =>
  `${DECISION_MODELS_DIR}/${id}`

const DECISION_TASK_PREFIX = 'decision-'

/** Download panel row and Rust task id. */
export const decisionDownloadTaskId = (id: string): string =>
  sanitizeTaskId(`${DECISION_TASK_PREFIX}${id}`)

export const isDecisionDownloadTaskId = (taskId: string): boolean =>
  taskId.startsWith(DECISION_TASK_PREFIX)

/** `file://` paths are resolved by the Rust fs commands against the data folder. */
const dataPath = (relative: string): string => `file://${relative}`

const exists = async (relative: string): Promise<boolean> => {
  try {
    return Boolean(await fs.existsSync(dataPath(relative)))
  } catch {
    return false
  }
}

/**
 * Files of `model` not on disk yet. The downloader writes each file under a
 * temporary name and renames it only after its size and sha256 check, so a
 * file that exists is a verified one.
 */
export async function missingDecisionFiles(
  model: DecisionCatalogModel
): Promise<DecisionCatalogFile[]> {
  const dir = decisionModelDir(model.id)
  const present = await Promise.all(
    model.files.map((file) => exists(`${dir}/${file.path}`))
  )
  return model.files.filter((_, index) => !present[index])
}

export async function isDecisionModelInstalled(
  model: DecisionCatalogModel
): Promise<boolean> {
  return (await missingDecisionFiles(model)).length === 0
}

export type DecisionDownloadOptions = {
  hfToken?: string
  resume?: boolean
}

/**
 * Download what `model` is still missing, under `decisionDownloadTaskId`, so
 * the standard download panel, the proxy setting and the Rust size/sha256
 * verification all apply. Resolves once every file is on disk.
 */
export async function downloadDecisionModel(
  model: DecisionCatalogModel,
  opts: DecisionDownloadOptions = {}
): Promise<void> {
  const missing = await missingDecisionFiles(model)
  if (missing.length === 0) return
  const taskId = decisionDownloadTaskId(model.id)
  const proxy = downloadProxyConfig()
  const total = missing.reduce((sum, file) => sum + file.bytes, 0)
  const dir = decisionModelDir(model.id)
  const items: TransferItem[] = missing.map((file) => ({
    url: decisionFileUrl(model, file),
    save_path: `${dir}/${file.path}`,
    ...(proxy ? { proxy } : {}),
    sha256: file.sha256,
    size: file.bytes,
    model_id: taskId,
  }))
  emitTransferProgress(taskId, 'Model', 0, total)
  try {
    await transferFiles(items, taskId, {
      resume: opts.resume ?? false,
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      onProgress: (transferred, size) =>
        emitTransferProgress(taskId, 'Model', transferred, size),
    })
  } catch (error) {
    if (isTransferValidationError(error)) {
      emitTransferValidationFailed(taskId, error)
    } else {
      emitTransferError(taskId, 'Model', error)
    }
    throw error
  }
  emitTransferSuccess(taskId, 'Model', total)
}

/** Whether the core is configured to run `id` (running or not). */
export const isActiveDecisionModel = (
  config: Pick<DecisionConfig, 'model_path'> | null,
  id: string
): boolean => config?.model_path === decisionModelDir(id)

/**
 * Point the core at `model` and start it; resolves once the engine is ready.
 * A failure rejects with the core's `{code, message, details?}`. Another
 * model that was running is replaced: one decision model runs at a time.
 */
export async function activateDecisionModel(
  model: DecisionCatalogModel
): Promise<DecisionStatus> {
  const decision = getServiceHub().decision()
  await decision.setConfig({
    enabled: true,
    model_path: decisionModelDir(model.id),
    model_id: model.id,
  })
  return decision.load()
}

/** Stop the decision model and keep it from starting on the next call. */
export async function stopDecisionModel(): Promise<void> {
  await getServiceHub().decision().setConfig({ enabled: false })
}

/**
 * Remove `model` from disk. An active model is first turned off and cleared
 * from the core's settings: the process must let go of the folder (Windows
 * cannot delete a mapped file), and the core then drops its cached GGUF.
 */
export async function deleteDecisionModel(
  model: DecisionCatalogModel,
  config: Pick<DecisionConfig, 'model_path'> | null
): Promise<void> {
  if (isActiveDecisionModel(config, model.id)) {
    await getServiceHub()
      .decision()
      .setConfig({ enabled: false, model_path: '', model_id: '' })
  }
  const dir = decisionModelDir(model.id)
  if (await exists(dir)) await fs.rm(dataPath(dir))
}
