import { isArmArch } from '@/lib/hardware-tier'

/**
 * Whether TurboQuant ships a build for this desktop, so a decision model can
 * run: macOS on Apple silicon, Windows and Linux on x64. There is no fork
 * build for macOS x64, Windows arm64 or Linux arm64. An arch not reported yet
 * counts as supported, so the page does not flicker away while the hardware
 * facts load.
 */
export function isDecisionHostSupported(arch: string | undefined): boolean {
  if (!arch) return true
  const arm = isArmArch(arch)
  if (IS_MACOS) return arm
  if (IS_WINDOWS || IS_LINUX) return !arm
  return false
}
