import { Readable } from 'stream';
import { ObjectStorage, StoredObject } from './object-storage';

/**
 * TEST-ONLY storage driver (STORAGE_DRIVER=memory, accepted only with APP_ENV=test).
 * Implements the same contract as S3 so the full upload/validation/delivery path is exercised.
 */
export class MemoryObjectStorage implements ObjectStorage {
  readonly configured = true;
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, body: Buffer | Readable, opts: { contentType: string }) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const c of body) chunks.push(Buffer.from(c));
    this.objects.set(key, { data: Buffer.concat(chunks), contentType: opts.contentType });
  }

  async get(key: string, range?: string): Promise<StoredObject> {
    const obj = this.objects.get(key);
    if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      const size = obj.data.length;
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const slice = obj.data.subarray(start, end + 1);
      return { body: Readable.from(slice), contentType: obj.contentType, contentLength: slice.length, contentRange: `bytes ${start}-${end}/${size}`, partial: true };
    }
    return { body: Readable.from(obj.data), contentType: obj.contentType, contentLength: obj.data.length, partial: false };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}
