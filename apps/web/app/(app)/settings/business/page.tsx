'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useBusiness } from '@/components/business-provider';

/** Phase 1 URL kept for compatibility: forwards to the active business page. */
export default function LegacyBusinessSettings() {
  const { active } = useBusiness();
  const router = useRouter();
  useEffect(() => {
    if (active) router.replace(`/dashboard/businesses/${active.id}`);
  }, [active, router]);
  return null;
}
