import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CreativeProviderError } from './types';
import { checkVideoProvider } from './video-contract';
import { FakeVideoProvider } from './testing/fake';
import { HiggsfieldProvider, MOCK_VIDEO_SECONDS, MockScriptProvider, MockVideoProvider } from './mock-studio';

describe('free test mode providers', () => {
  it('ships four local 8-second demo videos (valid MP4 files)', () => {
    for (const f of ['9x16', '16x9', '1x1', '4x5']) {
      const p = join(__dirname, '..', 'assets', `demo-video-${f}.mp4`);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p).subarray(4, 8).toString()).toBe('ftyp');
    }
  });
  it('the mock video provider has a fixed 8-second reference, serves local files, and can simulate a failure', async () => {
    const v = new MockVideoProvider();
    expect(v.capabilities.seconds).toEqual([MOCK_VIDEO_SECONDS]);
    const { ref } = await v.submit({ model: 'mock', prompt: 'x', seconds: 8, size: { width: 360, height: 640 }, timeoutMs: 1000 });
    expect(await v.status()).toMatchObject({ state: 'completed' });
    const d = await v.download(ref);
    expect(d.mime).toBe('video/mp4');
    expect(d.data.length).toBeGreaterThan(10_000);
    await expect(v.submit({ model: 'mock', prompt: 'please simulate-failure now', seconds: 8, size: { width: 360, height: 640 }, timeoutMs: 1000 })).rejects.toBeInstanceOf(CreativeProviderError);
  });
  it('the script provider is deterministic, reuses only the client\'s words and says it is simulated', async () => {
    const s = new MockScriptProvider();
    const a = await s.generate({ brief: 'Fresh bissap juice for the weekend', language: 'en', seconds: 8, style: 'MINIMAL', brandName: 'Café Awa' });
    expect(a).toEqual(await s.generate({ brief: 'Fresh bissap juice for the weekend', language: 'en', seconds: 8, style: 'MINIMAL', brandName: 'Café Awa' }));
    expect(a.simulated).toBe(true);
    expect(a.disclaimer).toMatch(/Simulated/);
    expect(a.scenes.reduce((n, x) => n + x.seconds, 0)).toBe(8);
    expect(a.caption).toContain('Fresh bissap juice');
    expect(JSON.stringify(a)).not.toMatch(/guarantee|best in|100%/i);
    expect((await s.generate({ brief: 'Jus de bissap frais', language: 'fr', seconds: 8, style: 'MINIMAL' })).disclaimer).toMatch(/simulé/);
  });
  it('the Higgsfield provider is a disabled placeholder: never configured, refuses every call', async () => {
    const h = new HiggsfieldProvider();
    expect(h.isConfigured()).toBe(false);
    await expect(h.submit()).rejects.toThrow(/disabled/);
    await expect(h.status()).rejects.toThrow(/disabled/);
    await expect(h.download()).rejects.toThrow(/disabled/);
  });
  it('every VideoProvider passes the same contract: the simulators do, so a real provider can be swapped in and checked the same way', async () => {
    expect(await checkVideoProvider(new MockVideoProvider())).toEqual([]);
    expect(await checkVideoProvider(new FakeVideoProvider())).toEqual([]);
    // The disabled Higgsfield placeholder must NOT pass (it is not connected): it is reported, never silently accepted.
    await expect(checkVideoProvider(new HiggsfieldProvider())).resolves.toContain('isConfigured() must be true for a provider that is ready to run');
  });
});
