'use client';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import type { AgentMode, ConvStatus, Intent, LeadStatus } from './types';

export function LeadBadge({ status }: { status: LeadStatus }) {
  const { t } = useI18n();
  const v = status === 'WON' ? 'success' : status === 'OPPORTUNITY' || status === 'QUALIFIED' ? 'warning' : status === 'LOST' ? 'muted' : 'default';
  return <Badge variant={v} data-lead={status}>{t(`sales.lead.${status}`)}</Badge>;
}

export function ModeBadge({ mode, status }: { mode: AgentMode; status: ConvStatus }) {
  const { t } = useI18n();
  if (status === 'PENDING_HUMAN') return <Badge variant="warning" data-mode="needs-human">{t('sales.mode.needsHuman')}</Badge>;
  return <Badge variant={mode === 'AI_ACTIVE' ? 'success' : mode === 'HUMAN' ? 'default' : 'muted'} data-mode={mode}>{t(`sales.mode.${mode}`)}</Badge>;
}

export function IntentBadge({ intent }: { intent: Intent }) {
  const { t } = useI18n();
  if (intent === 'NONE') return null;
  return <Badge variant={intent === 'HIGH' ? 'warning' : 'muted'}>{t(`sales.purchaseIntent.${intent}`)}</Badge>;
}

export const flag = (lang: string | null) => (lang ? lang.toUpperCase() : '—');
