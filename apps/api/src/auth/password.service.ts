import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** argon2id with OWASP-recommended parameters (m=19MiB, t=2, p=1). */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  };

  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Constant-work verification used when the account does not exist. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(`dummy-${Math.random()}`);
    await this.verify(await this.dummyHash, password);
  }
}
