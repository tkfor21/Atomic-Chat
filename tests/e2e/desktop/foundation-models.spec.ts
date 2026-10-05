/**
 * Apple's on-device model, the third local engine the core runs. Hidden since
 * 2026-09-30 (ADR 2026-09-30-hide-the-apple-on-device-provider): the extension
 * no longer registers the provider, so the picker leaves it out even on a Mac
 * whose server answers `--check` with "available". Here the bundled server is
 * the core's scripted sidecar, which says exactly that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForChat } from '../harness/chat.js'
import { FOUNDATION_MODELS_PROVIDER, installFakeSidecar } from '../harness/bundled-sidecars.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const REPLY = 'ATOMIC-E2E-ON-DEVICE 9a44'

describe.skipIf(process.platform !== 'darwin')('the hidden on-device Foundation Models provider', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('foundation-models', {
      prepare: async (profile) => {
        await installFakeSidecar(profile, 'fm', { reply: REPLY })
        // A llama.cpp model beside it, so the app opens on the chat and the picker has a group.
        await writeFakeModel(profile, 'e2e/fake-model')
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is not offered in the model picker, even when the server says it is available', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await browser.$('[data-test-id="model-picker-trigger"]').click()
      const change = browser.$('button[aria-label="Change model"]')
      if (await change.isExisting()) await change.click()
      // The picker is open — the default provider's gear is there — and the
      // on-device provider's is not.
      await browser.$('[data-test-id="provider-settings-llamacpp-upstream"]').waitForExist({ timeout: 30_000 })
      await browser.pause(2_000)
      expect(await browser.$(`[data-test-id="provider-settings-${FOUNDATION_MODELS_PROVIDER}"]`).isExisting()).toBe(false)
    })
  })
})
