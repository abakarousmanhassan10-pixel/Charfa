'use client';
import { Textarea } from '@/components/ui/textarea';

/** Edits a string list as one item per line (max 20 items). */
export function ListInput({ id, value, onChange, disabled, describedBy }: { id: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; describedBy?: string }) {
  return (
    <Textarea
      id={id}
      rows={4}
      disabled={disabled}
      aria-describedby={describedBy}
      value={value.join('\n')}
      onChange={(e) => onChange(e.target.value.split('\n').slice(0, 20).map((l) => l.slice(0, 200)))}
    />
  );
}

export const cleanList = (v: string[]) => v.map((s) => s.trim()).filter(Boolean);
