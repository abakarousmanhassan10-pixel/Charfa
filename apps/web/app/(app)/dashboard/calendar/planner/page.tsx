'use client';
import { CalendarSection } from '@/components/calendar/calendar-section';
import { PlannerView } from '@/components/calendar/planner-view';
import { useI18n } from '@/components/i18n-provider';

export default function PlannerPage() {
  const { t } = useI18n();
  return (
    <CalendarSection title={t('calendar.planner.pageTitle')} description={t('calendar.planner.subtitle')}>
      <PlannerView />
    </CalendarSection>
  );
}
