import { Inject } from '@nestjs/common';
import { AppEnv } from '@touma/config';

export const APP_ENV = Symbol('APP_ENV');
export const InjectEnv = () => Inject(APP_ENV);
export type { AppEnv };
