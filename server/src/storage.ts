// Object storage for project files, published beats and samples. Two drivers
// with one interface: S3-compatible (AWS, MinIO, ...) and a plain directory
// for development and tests.

import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from './config.ts';

export interface Storage {
  /** Makes sure the backing store is reachable and usable. */
  ready(): Promise<void>;
  put(key: string, data: Buffer): Promise<void>;
  /** Rejects with a `code: 'ENOENT'` error when the object is missing. */
  get(key: string): Promise<Readable>;
  /** Missing keys are ignored. */
  remove(keys: string[]): Promise<void>;
}

function missing(key: string): Error {
  return Object.assign(new Error(`no such object: ${key}`), { code: 'ENOENT' });
}

export class FsStorage implements Storage {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`bad storage key: ${key}`);
    return p;
  }

  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    // write beside the target and rename, so readers never see half a file
    const tmp = join(dirname(p), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, data);
    await rename(tmp, p);
  }

  async get(key: string): Promise<Readable> {
    const p = this.path(key);
    try {
      await stat(p);
    } catch {
      throw missing(key);
    }
    return createReadStream(p);
  }

  async remove(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.path(k), { force: true })));
  }
}

export class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;

  constructor(cfg: Extract<StorageConfig, { driver: 's3' }>) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async ready(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: data, ContentLength: data.length, ContentType: 'application/octet-stream',
    }));
  }

  async get(key: string): Promise<Readable> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body as Readable;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') throw missing(key);
      throw err;
    }
  }

  async remove(keys: string[]): Promise<void> {
    // the API takes at most 1000 keys per call
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const out = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      if (out.Errors?.length) throw new Error(`could not delete ${out.Errors.length} objects, first: ${out.Errors[0].Key} ${out.Errors[0].Message}`);
    }
  }
}

export function createStorage(cfg: StorageConfig): Storage {
  return cfg.driver === 's3' ? new S3Storage(cfg) : new FsStorage(cfg.dir);
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
