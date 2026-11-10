'use client';
import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { ALLOWED_MIME_TYPES, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_VIDEO_BYTES } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { ApiError, uploadFile } from '@/lib/api-client';
import type { MediaItem } from './media-types';

interface Job {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/**
 * Uploads through the API (which re-validates content, size and type). Client-side checks are only
 * for fast feedback; the server is authoritative.
 */
export function MediaUploader({
  businessId,
  folder,
  accept = 'all',
  onUploaded,
  multiple = true,
}: {
  businessId: string;
  folder?: string;
  accept?: 'all' | 'image';
  onUploaded: (m: MediaItem) => void;
  multiple?: boolean;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const types = accept === 'image' ? ALLOWED_MIME_TYPES.filter((m) => m.startsWith('image/')) : ALLOWED_MIME_TYPES;

  const update = (key: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function handle(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setJobs((js) => [...js, { key, name: file.name, progress: 0 }]);
      if (!(types as string[]).includes(file.type)) {
        update(key, { error: t('media.errors.UNSUPPORTED_FILE_TYPE') });
        continue;
      }
      const max = file.type.startsWith('image/') ? DEFAULT_MAX_IMAGE_BYTES : DEFAULT_MAX_VIDEO_BYTES;
      if (file.size > max) {
        update(key, { error: t('media.errors.FILE_TOO_LARGE') });
        continue;
      }
      const form = new FormData();
      if (folder) form.append('folder', folder);
      form.append('file', file);
      try {
        const media = await uploadFile<MediaItem>('/media', form, {
          businessId,
          onProgress: (p) => update(key, { progress: Math.round((p.loaded / p.total) * 100) }),
        });
        update(key, { progress: 100 });
        onUploaded(media);
        setTimeout(() => setJobs((js) => js.filter((j) => j.key !== key)), 1500);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'UNKNOWN';
        const msg = t(`media.errors.${code}`);
        update(key, { error: msg.startsWith('media.errors.') ? (err as Error).message : msg });
      }
    }
    if (input.current) input.current.value = '';
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handle(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${dragging ? 'border-primary bg-primary/5' : ''}`}
      >
        <Upload className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">{accept === 'image' ? t('media.dropImages') : t('media.dropFiles')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
          {t('media.chooseFiles')}
        </Button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label={t('media.chooseFiles')}
          accept={types.join(',')}
          multiple={multiple}
          onChange={(e) => void handle(e.target.files)}
          data-testid="media-file-input"
        />
        <p className="text-xs text-muted-foreground">{t('media.limits')}</p>
      </div>
      {jobs.length > 0 && (
        <ul className="mt-3 grid gap-2" aria-live="polite">
          {jobs.map((j) => (
            <li key={j.key} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{j.name}</span>
                <span className={j.error ? 'text-destructive' : 'tabular-nums text-muted-foreground'}>{j.error ?? `${j.progress}%`}</span>
              </div>
              {!j.error && (
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={j.progress} aria-valuemin={0} aria-valuemax={100} aria-label={j.name}>
                  <div className="h-full bg-primary transition-all" style={{ width: `${j.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
