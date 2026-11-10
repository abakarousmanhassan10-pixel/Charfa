import Link from 'next/link';
import { Sparkles } from 'lucide-react';

export function Logo() {
  return (
    <Link href="/" className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="h-4 w-4" aria-hidden />
      </span>
      AIMA
    </Link>
  );
}
