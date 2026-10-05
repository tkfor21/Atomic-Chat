import { IconWorld } from '@tabler/icons-react'
import { useEffect, useMemo } from 'react'

import { CopyButton } from '@/containers/CopyButton'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { DecisionState } from '@/services/decision/types'
import { useDecisionStore } from '@/stores/decision-store'
import { getModelContextLength } from '@/utils/apiServerCapacity'
import { formatCount } from '@/utils/apiServerStats'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

import { MicroLabel, StatusDot, type StatusTone } from './ApiStatusIndicators'

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  )
}

/** `idle` is an enabled module unloaded for idling: the next request starts it. */
const DECISION_SERVED_STATES = new Set<DecisionState>([
  'idle',
  'starting',
  'ready',
  'restarting',
])

/** The decision model the server answers `/systemone` with, or `null` when none. */
function useServedDecisionModel(): {
  name: string
  ready: boolean
  starting: boolean
} | null {
  const status = useDecisionStore((s) => s.status)
  const config = useDecisionStore((s) => s.config)
  const catalog = useDecisionStore((s) => s.catalog)

  useEffect(() => useDecisionStore.getState().bind(), [])

  if (!status?.enabled || !DECISION_SERVED_STATES.has(status.state)) return null
  const id = config?.model_id ?? ''
  const name =
    catalog.models.find((model) => model.id === id)?.name ||
    id ||
    status.model_path?.split(/[\\/]/).pop() ||
    ''
  if (!name) return null
  return {
    name,
    ready: status.state === 'ready',
    starting: status.state === 'starting' || status.state === 'restarting',
  }
}

export function ApiConnectionStrip() {
  const { t } = useTranslation()
  const { serverStatus, activeModels } = useAppState()
  const decisionModel = useServedDecisionModel()
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer()

  const url = useMemo(
    () => getLocalApiServerUrl(),
    // Recompute when any part of the address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )

  const loadedModel = activeModels[0] ?? null
  const contextLength = getModelContextLength(loadedModel)

  const { tone, label }: { tone: StatusTone; label: string } =
    serverStatus === 'stopped'
      ? { tone: 'idle', label: t('api:status.stopped') }
      : serverStatus === 'pending'
        ? { tone: 'pending', label: t('api:status.starting') }
        : loadedModel || decisionModel?.ready
          ? { tone: 'ready', label: t('api:status.ready') }
          : { tone: 'idle', label: t('api:status.noModel') }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <IconWorld size={18} className="shrink-0 text-muted-foreground" />

      <Field label={t('api:strip.baseUrl')}>
        <span className="flex items-center gap-1 font-mono text-xs">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {url}
          </a>
          <CopyButton text={url} />
        </span>
      </Field>

      <Field label={t('api:strip.status')}>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} />
          {label}
        </span>
      </Field>

      <Field label={t('api:strip.loadedModel')} className="flex-1">
        <span className="block truncate" title={loadedModel ?? undefined}>
          {loadedModel ?? (
            <span className="text-muted-foreground">
              {t('api:strip.noModel')}
            </span>
          )}
          {loadedModel && contextLength ? (
            <span className="text-muted-foreground">
              {' · '}
              {t('api:strip.ctx', { count: formatCount(contextLength) })}
            </span>
          ) : null}
        </span>
      </Field>

      {decisionModel && (
        <Field label={t('api:strip.decisionModel')} className="flex-1">
          <span className="block truncate" title={decisionModel.name}>
            {decisionModel.name}
            {decisionModel.starting && (
              <span className="text-muted-foreground">
                {' · '}
                {t('api:status.starting')}
              </span>
            )}
          </span>
        </Field>
      )}
    </div>
  )
}
