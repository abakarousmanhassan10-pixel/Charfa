import type { Metadata } from 'next';
import { AiProviderBanner } from '@/components/ai/provider-banner';

export const metadata: Metadata = { title: 'TOUMA AI' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AiProviderBanner />
      {children}
    </>
  );
}
