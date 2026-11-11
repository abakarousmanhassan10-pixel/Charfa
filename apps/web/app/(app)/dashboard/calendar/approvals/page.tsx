'use client';
import { ApprovalsView } from '@/components/calendar/approvals-view';
import { CalendarSection } from '@/components/calendar/calendar-section';
import { useI18n } from '@/components/i18n-provider';

export default function ApprovalsPage() {
  const { t } = useI18n();
  return (
    <CalendarSection title={t('calendar.approvals.title')} description={t('calendar.approvals.subtitle')}>
      <ApprovalsView />
    </CalendarSection>
  );
}
