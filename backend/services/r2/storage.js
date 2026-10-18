// Cloudflare R2 adapter (S3-compatible API) built on the official AWS SDK v3.
//
// The SDK is imported lazily so that the HTTP server and /health start even if dependencies
// failed to install. Interface (also implemented by the in-memory test double):
//   putObject(key, buffer, {contentType})        putChunks(key, asyncIterable, {contentType})
//   getObjectBuffer(key) -> Buffer|null          getObjectStream(key) -> {stream,size}|null
//   headObject(key) -> {size,lastModified}|null  copyObject(src,dst)   deleteObject(key)
//   listObjects(prefix) -> [{key,size,lastModified}]

import { Readable } from 'node:stream';
import { assertSafeKey } from './keys.js';

export async function createR2Storage(r2) {
  const s3 = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');

  const bucket = r2.bucket;
  const client = new s3.S3Client({
    region: 'auto',
    endpoint: r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    forcePathStyle: true,
    // R2 does not accept the SDK's newer default CRC32 trailer checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  const notFound = (e) =>
    e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;

  return {
    kind: 'r2',

    async putObject(key, body, { contentType = 'application/octet-stream' } = {}) {
      assertSafeKey(key);
      await client.send(
        new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }),
      );
    },

    async putChunks(key, iterable, { contentType = 'application/octet-stream' } = {}) {
      assertSafeKey(key);
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: Readable.from(iterable, { objectMode: false }), ContentType: contentType },
        queueSize: 2,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    },

    async getObjectBuffer(key) {
      assertSafeKey(key);
      try {
        const res = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },

    async getObjectStream(key) {
      assertSafeKey(key);
      try {
        const res = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
        return { stream: res.Body, size: res.ContentLength ?? null };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },

    async headObject(key) {
      assertSafeKey(key);
      try {
        const res = await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(res.ContentLength), lastModified: res.LastModified ? res.LastModified.getTime() : 0 };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },

    async copyObject(sourceKey, destKey) {
      assertSafeKey(sourceKey);
      assertSafeKey(destKey);
      await client.send(new s3.CopyObjectCommand({ Bucket: bucket, Key: destKey, CopySource: `${bucket}/${sourceKey}` }));
    },

    async deleteObject(key) {
      assertSafeKey(key);
      await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key })); // idempotent
    },

    async listObjects(prefix) {
      assertSafeKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
      const out = [];
      let token;
      do {
        const res = await client.send(
          new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
        );
        for (const o of res.Contents ?? []) {
          out.push({ key: o.Key, size: Number(o.Size), lastModified: o.LastModified ? o.LastModified.getTime() : 0 });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },

    async close() {
      client.destroy();
    },
  };
}
