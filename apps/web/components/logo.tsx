import Link from 'next/link';
import { BRAND } from '@touma/shared';

/**
 * Logo placeholder: "T" monogram + wordmark. Swap the monogram for the final SVG mark
 * when brand assets are delivered; keep the accessible name.
 */
export function Logo({ showProduct = false }: { showProduct?: boolean }) {
  return (
    <Link
      href="/"
      aria-label={BRAND.productName}
      className="inline-flex items-center gap-2 font-semibold tracking-tight"
    >
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
      >
        T
      </span>
      <span className="text-base">
        {BRAND.name}
        {showProduct && <span className="ms-1 font-medium text-primary">AI</span>}
      </span>
    </Link>
  );
}
