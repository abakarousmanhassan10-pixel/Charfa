import { MemoryObjectStorage } from './memory-object-storage';
import { verifyStorage } from './verify';

describe('verifyStorage', () => {
  it('runs a full round trip (memory driver, without HTTP presign)', async () => {
    const r = await verifyStorage(new MemoryObjectStorage(), { presignedFetch: false });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['upload', 'head', 'download', 'delete', 'deleted-check']);
  });
  it('fails when a step fails', async () => {
    const m = new MemoryObjectStorage();
    m.failDeletes = 1;
    const r = await verifyStorage(m, { presignedFetch: false });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'delete')).toMatchObject({ ok: false });
  });
  it('flags memory presigned URLs as not real HTTP storage', async () => {
    const r = await verifyStorage(new MemoryObjectStorage());
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.step === 'presigned-download')?.error).toMatch(/does not issue HTTP/);
  });
});
