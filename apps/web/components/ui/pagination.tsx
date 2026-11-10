'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

export function Pagination({
  page,
  pageCount,
  total,
  onPage,
  labels,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
  labels: { previous: string; next: string; summary: string };
}) {
  if (total === 0) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-4 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {labels.summary}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label={labels.previous}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          <span className="hidden sm:inline">{labels.previous}</span>
        </Button>
        <span className="tabular-nums" aria-current="page">
          {page} / {pageCount}
        </span>
        <Button variant="outline" size="sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-label={labels.next}>
          <span className="hidden sm:inline">{labels.next}</span>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
