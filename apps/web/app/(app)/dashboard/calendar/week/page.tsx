'use client';
import { Suspense } from 'react';
import { CalendarBoard } from '@/components/calendar/calendar-board';
import { CalendarSection } from '@/components/calendar/calendar-section';
import { useI18n } from '@/components/i18n-provider';

export default function WeekPage() {
  const { t } = useI18n();
  return (
    <CalendarSection title={t('calendar.week.title')} description={t('calendar.week.subtitle')}>
      <Suspense fallback={null}>
        <CalendarBoard view="week" />
      </Suspense>
    </CalendarSection>
  );
}
