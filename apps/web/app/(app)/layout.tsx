'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3, Building2, CalendarDays, CreditCard, Image as ImageIcon, Inbox, LayoutDashboard,
  Loader2, LogOut, Package, Settings, Share2, Wand2,
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { LocaleSwitcher, useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Only routes that exist are links; the rest are shown as upcoming so nothing pretends to work.
const NAV = [
  { key: 'dashboard', href: '/dashboard', icon: LayoutDashboard, ready: true },
  { key: 'businesses', icon: Building2 },
  { key: 'products', icon: Package },
  { key: 'content', icon: Wand2 },
  { key: 'media', icon: ImageIcon },
  { key: 'calendar', icon: CalendarDays },
  { key: 'social', icon: Share2 },
  { key: 'inbox', icon: Inbox },
  { key: 'analytics', icon: BarChart3 },
  { key: 'billing', icon: CreditCard },
  { key: 'settings', icon: Settings },
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, logout } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="grid min-h-screen place-items-center text-muted-foreground" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin" aria-label={t('common.loading')} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-e bg-card p-4 md:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map((item) => {
            const Icon = item.icon;
            const label = t(`dashboard.nav.${item.key}`);
            if ('ready' in item) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={pathname === item.href ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent',
                    pathname === item.href && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                </Link>
              );
            }
            return (
              <span
                key={item.key}
                title={t('common.comingSoon')}
                aria-disabled="true"
                className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/70"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </span>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
          <div className="md:hidden">
            <Logo />
          </div>
          <div className="ms-auto flex items-center gap-3">
            <LocaleSwitcher />
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await logout();
                router.replace('/login');
              }}
            >
              <LogOut className="h-4 w-4 rtl:rotate-180" aria-hidden />
              {t('common.signOut')}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
