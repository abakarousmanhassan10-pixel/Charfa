import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mapS3Error, resolveS3Config, S3ObjectStorage } from './s3-object-storage';
import { StorageNotConfiguredError } from './object-storage';


describe('S3ObjectStorage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is not configured without credentials and refuses to operate', async () => {
    const storage = new S3ObjectStorage({ provider: 'aws' });
    expect(storage.configured).toBe(false);
    await expect(storage.get('k')).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it('sends private uploads, ranged gets and deletes to the configured bucket', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: 'stream', ContentType: 'image/png', ContentLength: 3, ContentRange: 'bytes 0-2/10' };
      return {};
    });
    const storage = new S3ObjectStorage({ provider: 'minio', bucket: 'b1', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', endpoint: 'http://localhost:9000' });
    expect(storage.configured).toBe(true);
    await storage.put('businesses/x/media/a.png', Buffer.from('abc'), { contentType: 'image/png', contentLength: 3 });
    const got = await storage.get('businesses/x/media/a.png', 'bytes=0-2');
    await storage.delete('businesses/x/media/a.png');

    const cmds = send.mock.calls.map((c) => c[0]);
    expect(cmds[0]).toBeInstanceOf(HeadBucketCommand);
    expect(cmds.some((c) => c.constructor.name === 'CreateBucketCommand')).toBe(false);
    const put = cmds.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: 'b1', Key: 'businesses/x/media/a.png', ContentType: 'image/png' });
    expect(put.input).not.toHaveProperty('ACL');
    const get = cmds.find((c) => c instanceof GetObjectCommand) as GetObjectCommand;
    expect(get.input).toEqual({ Bucket: 'b1', Key: 'businesses/x/media/a.png', Range: 'bytes=0-2' });
    expect(got).toMatchObject({ partial: true, contentRange: 'bytes 0-2/10' });
    expect(cmds.some((c) => c instanceof DeleteObjectCommand)).toBe(true);
  });
});

describe('provider presets and error mapping', () => {
  it('applies AWS / R2 / MinIO defaults', () => {
    expect(resolveS3Config({ provider: 'aws', region: 'eu-west-3' })).toMatchObject({ forcePathStyle: false, region: 'eu-west-3' });
    expect(resolveS3Config({ provider: 'r2', endpoint: 'https://acc.r2.cloudflarestorage.com' })).toMatchObject({ region: 'auto', forcePathStyle: false });
    expect(resolveS3Config({ provider: 'minio', region: 'us-east-1' })).toMatchObject({ forcePathStyle: true });
  });
  it('maps provider errors to storage error kinds without leaking details', () => {
    expect(mapS3Error({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }).kind).toBe('not_found');
    expect(mapS3Error({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }).kind).toBe('bucket_missing');
    expect(mapS3Error({ name: 'SignatureDoesNotMatch', message: 'secret=abc', $metadata: { httpStatusCode: 403 } })).toMatchObject({ kind: 'access_denied' });
    expect(mapS3Error({ name: 'SignatureDoesNotMatch', message: 'secret=abc', $metadata: { httpStatusCode: 403 } }).message).not.toContain('secret');
    expect(mapS3Error({ code: 'ECONNREFUSED' }).kind).toBe('unavailable');
    expect(mapS3Error({ name: 'InternalError', $metadata: { httpStatusCode: 503 } }).kind).toBe('unavailable');
  });
  it('treats deleting a missing object as success and head of missing as null', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send').mockRejectedValue({ name: 'NotFound', $metadata: { httpStatusCode: 404 } } as never);
    const s = new S3ObjectStorage({ provider: 'aws', bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
    await expect(s.delete('x')).resolves.toBeUndefined();
    await expect(s.head('x')).resolves.toBeNull();
    send.mockRestore();
  });
});
