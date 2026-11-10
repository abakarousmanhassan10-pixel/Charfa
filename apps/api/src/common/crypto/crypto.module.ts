import { Global, Module } from '@nestjs/common';
import { APP_ENV, AppEnv } from '../../config';
import { TokenCipher } from './token-cipher';

@Global()
@Module({
  providers: [
    { provide: TokenCipher, inject: [APP_ENV], useFactory: (env: AppEnv) => new TokenCipher(env.TOKEN_ENCRYPTION_KEY) },
  ],
  exports: [TokenCipher],
})
export class CryptoModule {}
