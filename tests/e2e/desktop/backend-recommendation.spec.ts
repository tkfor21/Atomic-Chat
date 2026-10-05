/**
 * Since ADR 2026-09-27 the core is the only source of hardware facts and the
 * one that says which backend fits: the app injects nothing and asks. This
 * scenario watches that from the outside of the app — through the core's
 * control API next to the running app — while the app does what it always
 * did on a fresh profile: look for a newer backend and install it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proxySeed, startBackendMirror, type BackendMirror } from '../harness/backend-mirror.js'
import { waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { FAKE_BACKEND, FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const OLD_TAG = 'b99990'
const NEW_TAG = 'b99999'
const NEW_BACKEND = `${NEW_TAG}/${FAKE_BACKEND}`

async function coreJson<T>(dataFolder: string, path: string, body?: unknown): Promise<T> {
  const response = await coreRequest(dataFolder, path, {
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200)
  return (await response.json()) as T
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the core decides which backend fits; the app only asks', () => {
  let session: Session
  let mirror: BackendMirror

  beforeAll(async () => {
    mirror = await startBackendMirror({ tag: NEW_TAG, reply: 'ATOMIC-E2E-NEW-BACKEND 5c1a' })
    session = await startSession('backend-recommendation', {
      backendVersion: OLD_TAG,
      alsoAllowedBackends: [`${FAKE_PROVIDER}:${NEW_BACKEND}`],
      webviewSeed: proxySeed(mirror.proxyUrl),
      prepare: async (profile) => {
        await installFakeBackend(profile, { version: OLD_TAG, reply: 'ATOMIC-E2E-OLD-BACKEND 2b90' })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await mirror?.stop()
    expect(left).toEqual([])
  })

  it('never receives an override from the app, and answers the catalog the app shows', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)

      // The app attached, imported its settings and configured its backends without describing
      // the machine to the core: the core's own probe is what selection runs on.
      expect(await coreJson<{ override: unknown }>(dataFolder, '/hardware/override')).toEqual({ override: null })
      const hardware = await coreJson<{ source: string; info: { os_type: string; gpus: unknown[]; cpu: { arch: string } } }>(
        dataFolder,
        '/hardware/info'
      )
      expect(hardware.source).toBe('probe')
      expect(hardware.info.os_type).toBe('macos')
      expect(hardware.info.gpus).toEqual([])

      // What fits this machine, asked the way the extension asks it (the user's proxy in the body).
      const proxy = { url: mirror.proxyUrl, ignore_ssl: true }
      const catalog = await coreJson<{
        hardware_source: string
        recommended: string | null
        installed: Array<{ version: string; backend: string }>
        latest_by_type: Record<string, string>
      }>(dataFolder, `/backends/${FAKE_PROVIDER}/catalog`, { proxy })
      expect(catalog.hardware_source).toBe('probe')
      expect(catalog.installed.map((entry) => entry.version)).toContain(OLD_TAG)
      expect(catalog.recommended).toBe(NEW_BACKEND)
      expect(catalog.latest_by_type[FAKE_BACKEND]).toBe(NEW_BACKEND)

      // The update question the banner is built from: newer, same family, offered.
      const updates = await coreJson<{ update_needed: boolean; same_family: boolean; offer: string | null }>(
        dataFolder,
        `/backends/${FAKE_PROVIDER}/updates`,
        { current: `${OLD_TAG}/${FAKE_BACKEND}`, proxy }
      )
      expect(updates).toMatchObject({ update_needed: true, same_family: true, offer: NEW_BACKEND })

      // On macOS there is one build; a recheck says so and stores no record.
      const verdict = await coreJson<{ outcome: string }>(dataFolder, `/backends/${FAKE_PROVIDER}/recommendation`, {
        mode: 'recheck',
        current_backend: `${OLD_TAG}/${FAKE_BACKEND}`,
        proxy,
      })
      expect(verdict.outcome).toBe('mac')

      // The mirror was reached only through the proxy the app carries, and the app still injected nothing.
      expect(mirror.seen()).toContain('CONNECT raw.githubusercontent.com:443')
      expect(await coreJson<{ override: unknown }>(dataFolder, '/hardware/override')).toEqual({ override: null })
    })
  }, 180_000)
})
