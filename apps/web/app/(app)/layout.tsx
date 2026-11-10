'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3, BookOpenCheck, BriefcaseBusiness, Building2, CalendarDays, CreditCard, FolderTree, Image as ImageIcon, Inbox,
  LayoutDashboard, Loader2, LogOut, Menu, Package, Share2, UserRound, Wand2, X,
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useBusiness } from '@/components/business-provider';
import { LocaleSwitcher, useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type NavItem = { key: string; icon: typeof LayoutDashboard; href?: string };

// Only implemented routes are links; upcoming modules are visibly disabled so nothing pretends to work.
const NAV: NavItem[] = [
  { key: 'dashboard', href: '/dashboard', icon: LayoutDashboard },
  { key: 'businesses', href: '/dashboard/businesses', icon: Building2 },
  { key: 'products', href: '/dashboard/products', icon: Package },
  { key: 'services', href: '/dashboard/services', icon: BriefcaseBusiness },
  { key: 'categories', href: '/dashboard/categories', icon: FolderTree },
  { key: 'media', href: '/dashboard/media', icon: ImageIcon },
  { key: 'knowledge', href: '/dashboard/knowledge', icon: BookOpenCheck },
  { key: 'ai', href: '/dashboard/ai', icon: Wand2 },
  { key: 'calendar', icon: CalendarDays },
  { key: 'social', icon: Share2 },
  { key: 'inbox', icon: Inbox },
  { key: 'analytics', icon: BarChart3 },
  { key: 'billing', icon: CreditCard },
  { key: 'profile', href: '/settings/profile', icon: UserRound },
];

function Spinner({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen place-items-center text-muted-foreground" aria-busy="true">
      <Loader2 className="h-6 w-6 animate-spin" aria-label={label} />
    </div>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-1" aria-label={t('common.menu')}>
      {NAV.map(({ key, href, icon: Icon }) => {
        const label = t(`dashboard.nav.${key}`);
        if (!href) {
          return (
            <span
              key={key}
              title={t('common.comingSoon')}
              aria-disabled="true"
              className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/70"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </span>
          );
        }
        const active = href === '/dashboard' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={key}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent',
              active && 'bg-accent text-accent-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, user, logout } = useAuth();
  const { status: bizStatus, businesses, active, setActive } = useBusiness();
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const onboarding = pathname === '/onboarding';

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    if (status === 'authenticated' && bizStatus === 'ready' && businesses.length === 0 && !onboarding) {
      router.replace('/onboarding');
    }
  }, [status, bizStatus, businesses.length, onboarding, router]);

  // The shell swaps between layouts (onboarding ↔ app); always start a new page at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (status !== 'authenticated' || bizStatus === 'loading') return <Spinner label={t('common.loading')} />;
  if (onboarding) return <>{children}</>;
  if (bizStatus === 'error') {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div>
          <p>{t('common.loadError')}</p>
          <Button className="mt-4" onClick={() => location.reload()}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }
  if (!active) return <Spinner label={t('common.loading')} />;

  const signOut = async () => {
    await logout();
    router.replace('/login');
  };

  const sidebar = (onNavigate?: () => void) => (
    <>
      <div className="px-2 pb-6">
        <Logo showProduct />
        <p className="mt-2 text-xs text-muted-foreground">{t('common.slogan')}</p>
      </div>
      <Nav onNavigate={onNavigate} />
      <div className="mt-4 border-t pt-4 text-xs text-muted-foreground">
        <p className="truncate px-2 font-medium text-foreground">{user?.fullName}</p>
        <p className="truncate px-2">{user?.email}</p>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-e bg-card p-4 md:flex">
        {sidebar()}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t('common.menu')}>
          <button className="absolute inset-0 bg-black/40" aria-label={t('common.close')} onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 start-0 flex w-72 flex-col overflow-y-auto bg-card p-4 shadow-xl">
            <Button variant="ghost" size="icon" className="absolute end-2 top-2" onClick={() => setDrawerOpen(false)} aria-label={t('common.close')}>
              <X className="h-5 w-5" />
            </Button>
            {sidebar(() => setDrawerOpen(false))}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/90 px-4 py-3 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawerOpen(true)} aria-label={t('common.menu')}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="min-w-0 max-w-64 flex-1">
            <label className="sr-only" htmlFor="active-business">
              {t('dashboard.switchBusiness')}
            </label>
            <Select id="active-business" value={active.id} onChange={(e) => setActive(e.target.value)} className="h-9">
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="ms-auto flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:block">
              <LocaleSwitcher />
            </div>
            <Button variant="outline" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4 rtl:rotate-180" aria-hidden />
              <span className="hidden sm:inline">{t('common.signOut')}</span>
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
