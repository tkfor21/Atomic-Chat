/**
 * The Logs window and "Export logs", end to end: a model loaded through the core
 * leaves engine lines in the core's own `core.log`; the Logs window shows them
 * next to the app's lines, marked Core, at the very time written in the file;
 * and an export writes one file holding both sources behind its header.
 *
 * Needs a core that writes `core.log` (atomic-chat-core with `add-unified-logs`):
 * run with ATOMIC_CORE_BIN pointing at such a build until the app pins one.
 * The save dialog is answered from the e2e queue; the rest is the shipped code.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { answerNextDialog, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-LOGS 5b8e'
const HEADER = /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[([^\]]*)\]\[[A-Z]+\] (.*)$/
const ENTRY = '[data-testid="log-entry"]'

async function coreLog(dataFolder: string): Promise<string> {
  return readFile(join(dataFolder, 'atomic-core', 'logs', 'core.log'), 'utf8').catch(() => '')
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the Logs window and its export', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('logs-export', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('shows engine lines marked Core at their file time and exports both sources', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'e2e logs ping')
      await pageShows(session, REPLY, 90_000)

      // The core wrote the engine's output into its own log.
      await expect.poll(() => coreLog(dataFolder), { timeout: 15_000 }).toContain('[engine:')
      const engineLine = (await coreLog(dataFolder))
        .split('\n')
        .find((line) => HEADER.exec(line)?.[3]?.startsWith('engine:'))!
      const [, date, time, target, message] = HEADER.exec(engineLine)!

      // The window the "Open Logs" button opens is this route.
      await browser.execute(() => window.location.assign('/logs'))
      await browser.$(ENTRY).waitForExist({ timeout: 30_000 })

      // That exact engine line is in the timeline, marked Core, at the file's time.
      await browser.waitUntil(
        async () => {
          const rows = await browser.$$(ENTRY)
          for (const row of rows) {
            const text = await row.getText()
            if (text.includes(target!) && text.includes(message!.slice(0, 40))) {
              return text.includes(`[${date} ${time} UTC]`) && text.includes('Core')
            }
          }
          return false
        },
        { timeout: 15_000, timeoutMsg: `no Core row for: ${engineLine}` }
      )

      // Export through the queued save-dialog answer.
      const exported = join(session.profile.root, 'atomic-chat-logs-e2e.log')
      await answerNextDialog(session.profile, exported)
      await browser.$('button=Export logs').click()
      await pageShows(session, 'Logs exported', 15_000)

      const text = await readFile(exported, 'utf8')
      const [header, body] = text.split('\n\n', 2) as [string, string]
      expect(header.split('\n').every((line) => line.startsWith('# '))).toBe(true)
      expect(header).toMatch(/^# timezone: UTC \(local UTC[+-]\d{2}:\d{2}\)$/m)
      expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[app\]\[/m)
      expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[core\]\[engine:/m)
      expect(body).toContain(`[${date}][${time}][core][${target}]`)
    })
  })
})
