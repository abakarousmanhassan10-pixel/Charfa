import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { loadEnv } from '@touma/config';
import { PrismaClient } from '@touma/database';
import { createApp } from '../src/bootstrap';

export async function startApp(): Promise<INestApplication> {
  const app = await createApp(loadEnv(), { logger: false });
  await app.init();
  return app;
}

export const prisma = new PrismaClient();

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Session", "Membership", "Notification", "Business", "User" RESTART IDENTITY CASCADE',
  );
}

let counter = 0;
export function uniqueEmail() {
  counter += 1;
  return `user${Date.now()}${counter}@example.com`;
}

export const STRONG_PASSWORD = 'Correct-Horse-9-Battery';

export function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith('touma_rt='))?.split(';')[0];
}

export async function register(app: INestApplication, email = uniqueEmail()) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: STRONG_PASSWORD, fullName: 'Test User' })
    .expect(201);
  return { email, accessToken: res.body.accessToken as string, cookie: refreshCookie(res)!, body: res.body };
}
