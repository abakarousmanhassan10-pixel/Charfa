import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv } from '@touma/config';
import { S3ObjectStorage } from './s3-object-storage';
import { StorageNotConfiguredError } from './object-storage';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('S3ObjectStorage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is not configured without credentials and refuses to operate', async () => {
    const storage = new S3ObjectStorage(loadEnv(base));
    expect(storage.configured).toBe(false);
    await expect(storage.get('k')).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it('sends private uploads, ranged gets and deletes to the configured bucket', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: 'stream', ContentType: 'image/png', ContentLength: 3, ContentRange: 'bytes 0-2/10' };
      return {};
    });
    const storage = new S3ObjectStorage(
      loadEnv({ ...base, S3_BUCKET: 'b1', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://localhost:9000' }),
    );
    expect(storage.configured).toBe(true);
    await storage.put('businesses/x/media/a.png', Buffer.from('abc'), { contentType: 'image/png', contentLength: 3 });
    const got = await storage.get('businesses/x/media/a.png', 'bytes=0-2');
    await storage.delete('businesses/x/media/a.png');

    const cmds = send.mock.calls.map((c) => c[0]);
    expect(cmds[0]).toBeInstanceOf(HeadBucketCommand);
    const put = cmds.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: 'b1', Key: 'businesses/x/media/a.png', ContentType: 'image/png' });
    expect(put.input).not.toHaveProperty('ACL');
    const get = cmds.find((c) => c instanceof GetObjectCommand) as GetObjectCommand;
    expect(get.input).toEqual({ Bucket: 'b1', Key: 'businesses/x/media/a.png', Range: 'bytes=0-2' });
    expect(got).toMatchObject({ partial: true, contentRange: 'bytes 0-2/10' });
    expect(cmds.some((c) => c instanceof DeleteObjectCommand)).toBe(true);
  });
});
