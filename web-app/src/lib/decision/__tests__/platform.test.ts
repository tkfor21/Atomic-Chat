import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDecisionHostSupported } from '../platform'

const onHost = (os: 'macos' | 'windows' | 'linux') => {
  vi.stubGlobal('IS_MACOS', os === 'macos')
  vi.stubGlobal('IS_WINDOWS', os === 'windows')
  vi.stubGlobal('IS_LINUX', os === 'linux')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isDecisionHostSupported', () => {
  it('runs on Apple silicon only on macOS', () => {
    onHost('macos')
    expect(isDecisionHostSupported('aarch64')).toBe(true)
    expect(isDecisionHostSupported('x86_64')).toBe(false)
  })

  it('runs on x64 only on Windows and Linux', () => {
    for (const os of ['windows', 'linux'] as const) {
      onHost(os)
      expect(isDecisionHostSupported('x86_64')).toBe(true)
      expect(isDecisionHostSupported('aarch64')).toBe(false)
    }
  })

  it('counts an arch not reported yet as supported', () => {
    onHost('macos')
    expect(isDecisionHostSupported('')).toBe(true)
    expect(isDecisionHostSupported(undefined)).toBe(true)
  })
})
