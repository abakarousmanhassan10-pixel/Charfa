import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Content calendar' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
