'use client';
import { Search } from 'lucide-react';
import { Input } from './input';

export function SearchInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} className="ps-9" maxLength={100} />
    </div>
  );
}
