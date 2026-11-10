import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();
  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('CorrectHorse9Battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await service.verify(hash, 'CorrectHorse9Battery')).toBe(true);
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });
  it('returns false on malformed hash instead of throwing', async () => {
    expect(await service.verify('not-a-hash', 'x')).toBe(false);
  });
});
