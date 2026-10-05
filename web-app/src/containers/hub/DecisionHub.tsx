import { useEffect, useMemo, type ReactNode } from 'react'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import HeaderPage from '@/containers/HeaderPage'
import { ModelLogo } from '@/containers/ModelLogo'
import { DecisionModelDetailPanel } from '@/containers/hub/DecisionModelDetailPanel'
import { HubNoResults, HubSearchInput } from '@/containers/hub/HubSearch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { filterDecisionModels } from '@/lib/hub-media'
import { DECISION_ICON_KEY } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'

export type DecisionHubProps = {
  /** The model type picker, painted above the list. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Catalog id named by the URL. */
  selectedModelId: string | null
  onSelectModel: (modelId: string, options?: { replace?: boolean }) => void
}

const repoOwner = (repo: string) => repo.split('/')[0]

function DecisionModelRow({
  model,
  installed,
  selected,
  onSelect,
}: {
  model: DecisionCatalogModel
  installed: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-3 text-left transition-colors hover:bg-accent',
        selected && 'border-border bg-accent'
      )}
    >
      <ModelLogo
        icon={DECISION_ICON_KEY}
        name={model.name}
        author={repoOwner(model.repo)}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {model.name}
          </span>
          {installed && (
            <IconCircleCheckFilled
              size={16}
              className="shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-label={t('hub:downloaded')}
            />
          )}
        </span>
        <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {model.repo}
        </span>
      </span>
    </button>
  )
}

/**
 * The Hub's Decision category: the curated decision catalog in the Hub's
 * two-column layout. Downloaded models come first; they are started from the
 * llama.cpp TurboQuant provider page, where Open leads.
 */
export function DecisionHub({
  categoryTabs,
  query,
  onQueryChange,
  selectedModelId,
  onSelectModel,
}: DecisionHubProps) {
  const { t } = useTranslation()
  const catalog = useDecisionStore((s) => s.catalog)
  const installed = useDecisionStore((s) => s.installed)

  useEffect(() => useDecisionStore.getState().bind(), [])

  const sections = useMemo(() => {
    const shown = filterDecisionModels(catalog.models, query)
    return {
      installed: shown.filter((model) => installed[model.id]),
      available: shown.filter((model) => !installed[model.id]),
    }
  }, [catalog.models, query, installed])

  // Resolved against the whole catalog: a search that hides the open model
  // should not blank the panel beside it.
  const selectedModel =
    catalog.models.find((model) => model.id === selectedModelId) ?? null
  const firstModelId = (sections.installed[0] ?? sections.available[0])?.id

  useEffect(() => {
    if (selectedModel || !firstModelId) return
    onSelectModel(firstModelId, { replace: true })
  }, [selectedModel, firstModelId, onSelectModel])

  const isEmpty =
    sections.installed.length === 0 && sections.available.length === 0

  const renderSection = (
    label: string,
    items: DecisionCatalogModel[],
    downloaded: boolean
  ) =>
    items.length > 0 && (
      <section>
        <h2 className="px-2 pb-2 pt-4 text-base font-semibold text-foreground">
          {label}
        </h2>
        <div className="flex flex-col gap-1">
          {items.map((model) => (
            <DecisionModelRow
              key={model.id}
              model={model}
              installed={downloaded}
              selected={model.id === selectedModel?.id}
              onSelect={() => onSelectModel(model.id)}
            />
          ))}
        </div>
      </section>
    )

  return (
    <div
      className="grid h-svh w-full grid-cols-[minmax(320px,420px)_1fr] grid-rows-[auto_minmax(0,1fr)]"
      data-testid="decision-hub"
    >
      <HeaderPage>
        <div
          className={cn(
            'relative z-20 flex h-10 w-full items-center gap-2 py-3 pr-3',
            !IS_MACOS && !IS_WINDOWS && 'pr-30'
          )}
          {...(IS_WINDOWS || IS_MACOS
            ? { 'data-tauri-drag-region': true }
            : {})}
        >
          <HubSearchInput
            value={query}
            onChange={onQueryChange}
            placeholder={t('hub:searchDecisionPlaceholder')}
          />
        </div>
      </HeaderPage>

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        {categoryTabs && (
          <div className="border-b border-border p-3">{categoryTabs}</div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isEmpty ? (
            <HubNoResults
              message={t('hub:noModels')}
              onClearSearch={
                query.length > 0 ? () => onQueryChange('') : undefined
              }
            />
          ) : (
            <>
              {renderSection(t('hub:downloaded'), sections.installed, true)}
              {renderSection(t('hub:available'), sections.available, false)}
            </>
          )}
        </div>
      </div>

      <div className="col-start-2 row-span-2 row-start-1 min-h-0 min-w-0 overflow-y-auto">
        <DecisionModelDetailPanel model={selectedModel} />
      </div>
    </div>
  )
}
