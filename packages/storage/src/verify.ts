import { randomUUID } from 'crypto';
import type { ObjectStorage } from './object-storage';

export interface VerificationStep {
  step: 'upload' | 'head' | 'download' | 'presigned-download' | 'delete' | 'deleted-check';
  ok: boolean;
  ms: number;
  error?: string;
}

export interface VerificationReport {
  ok: boolean;
  storage: string;
  checkedAt: string;
  steps: VerificationStep[];
}

/**
 * Real round trip against the configured storage: upload → head → download (bytes compared) →
 * provider-presigned download over HTTP → delete → confirm deletion. Storage is reported as
 * working only when every step succeeds.
 */
export async function verifyStorage(storage: ObjectStorage, opts: { presignedFetch?: boolean; prefix?: string } = {}): Promise<VerificationReport> {
  const steps: VerificationStep[] = [];
  const key = `${opts.prefix ?? '_healthcheck'}/${randomUUID()}.txt`;
  const payload = Buffer.from(`touma-storage-check ${new Date().toISOString()} ${randomUUID()}`);
  const run = async (step: VerificationStep['step'], fn: () => Promise<void>) => {
    const t = Date.now();
    try {
      await fn();
      steps.push({ step, ok: true, ms: Date.now() - t });
      return true;
    } catch (err) {
      steps.push({ step, ok: false, ms: Date.now() - t, error: (err as Error).message.slice(0, 200) });
      return false;
    }
  };
  const readAll = async (s: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  };

  if (!storage.configured) return { ok: false, storage: storage.description, checkedAt: new Date().toISOString(), steps: [{ step: 'upload', ok: false, ms: 0, error: 'not configured' }] };

  const uploaded = await run('upload', () => storage.put(key, payload, { contentType: 'text/plain', contentLength: payload.length }));
  if (uploaded) {
    await run('head', async () => {
      const h = await storage.head(key);
      if (!h || h.size !== payload.length) throw new Error(`unexpected size ${h?.size}`);
    });
    await run('download', async () => {
      const got = await readAll((await storage.get(key)).body);
      if (!got.equals(payload)) throw new Error('downloaded bytes differ from uploaded bytes');
    });
    if (opts.presignedFetch !== false) {
      await run('presigned-download', async () => {
        const url = await storage.presignGet(key, 60);
        if (!/^https?:\/\//.test(url)) throw new Error('provider does not issue HTTP presigned URLs');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!Buffer.from(await res.arrayBuffer()).equals(payload)) throw new Error('presigned download differs');
        const unsigned = await fetch(url.split('?')[0]!);
        if (unsigned.ok) throw new Error('object is publicly readable without a signature');
      });
    }
    await run('delete', () => storage.delete(key));
    await run('deleted-check', async () => {
      if (await storage.head(key)) throw new Error('object still exists after delete');
    });
  }
  return { ok: steps.every((s) => s.ok), storage: storage.description, checkedAt: new Date().toISOString(), steps };
}
