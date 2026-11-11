'use client';
import { useBusiness } from '@/components/business-provider';
import { useResource } from '@/lib/use-resource';
import type { SocialAccount, SocialStatus } from './types';

export function useSocialStatus() {
  const { active } = useBusiness();
  return useResource<SocialStatus>('/social/status', active?.id);
}

export function useAccounts() {
  const { active } = useBusiness();
  return useResource<{ items: SocialAccount[] }>('/social/accounts', active?.id);
}
