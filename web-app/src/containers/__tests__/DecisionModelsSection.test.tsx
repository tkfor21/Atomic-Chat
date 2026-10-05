import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'

const mocks = vi.hoisted(() => ({ apiSupported: true, arch: '' }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string
    search?: Record<string, string>
    children: React.ReactNode
  }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`}>{children}</a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    decision: () => ({ isSupported: () => mocks.apiSupported }),
  }),
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (
    selector: (s: { hardwareData: { cpu: { arch: string } } }) => unknown
  ) => selector({ hardwareData: { cpu: { arch: mocks.arch } } }),
}))

vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    ...actual,
    PlatformFeatures: { ...actual.PlatformFeatures, localInference: true },
  }
})

vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    checkForEngineUpdate: vi.fn(),
    recheckOptimalBackend: vi.fn(),
    downloadRecommendedBackend: vi.fn(),
  }),
}))

vi.mock('@/containers/DecisionModelCard', () => ({
  default: ({ model }: { model: DecisionCatalogModel }) => (
    <span>{`actions for ${model.id}`}</span>
  ),
  DecisionModelStatus: ({ model }: { model: DecisionCatalogModel }) => (
    <span>{`status of ${model.id}`}</span>
  ),
}))

import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'
import { DecisionModelsSection } from '../DecisionModelsSection'

const bind = vi.fn(() => () => {})

describe('DecisionModelsSection', () => {
  beforeEach(() => {
    mocks.apiSupported = true
    mocks.arch = ''
    bind.mockClear()
    useDecisionStore.setState({
      catalog: getBaselineDecisionCatalog(),
      installed: { 'laya': true },
      status: null,
      error: null,
      bind,
    })
  })

  it('lists only the downloaded models, each with its actions', () => {
    render(<DecisionModelsSection />)

    expect(
      screen.getByRole('heading', { name: 'settings:decision.sectionTitle' })
    ).toBeVisible()
    expect(screen.getByText('actions for laya')).toBeVisible()
    expect(screen.getByText('status of laya')).toBeVisible()
    expect(
      screen.queryByText('actions for laya-multilingual')
    ).not.toBeInTheDocument()
    expect(bind).toHaveBeenCalledOnce()
  })

  it('sends to the Decision category of the Hub when none is downloaded', () => {
    useDecisionStore.setState({ installed: {} })
    render(<DecisionModelsSection />)

    expect(screen.getByText('settings:decision.noneTitle')).toBeVisible()
    expect(screen.getByRole('link', { name: 'common:hub' })).toHaveAttribute(
      'href',
      '/hub/?category=decision'
    )
  })

  it('shows the failure, with the engine install next to an engine too old', () => {
    useDecisionStore.setState({
      error: {
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message: 'no --decision flag',
      },
    })
    render(<DecisionModelsSection />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:decision.errors.engineUnsupported'
    )
    expect(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    ).toBeVisible()
  })

  it('renders nothing where decision models cannot run', () => {
    mocks.apiSupported = false
    const { container } = render(<DecisionModelsSection />)

    expect(container).toBeEmptyDOMElement()
    expect(bind).not.toHaveBeenCalled()
  })
})
