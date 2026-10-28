import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fitReferenceImages, referenceBodyBytes, referenceJpeg} from '../lib/reference-images.mjs';
import {run, binaries, probe} from '../lib/media.mjs';

const base = {prompt: '保留构图和参考顺序', images: [], duration: 5, resolution: '1080p', aspect_ratio: '9:16'};
test('Q4 inputs below the byte limit are unchanged without transcoding', async () => {
  const input = {...base, images: ['data:image/png;base64,a']};
  assert.equal(await fitReferenceImages(input, () => assert.fail('must not encode')), input);
});
test('oversized Q4 bodies use smaller transport copies, preserving prompt and reference order', async () => {
  const images = ['data:image/png;base64,' + 'a'.repeat(2000), 'data:image/png;base64,b'];
  const input = {...base, images};
  const result = await fitReferenceImages(input, async i => ['data:image/jpeg;base64,first', 'data:image/jpeg;base64,' + 'b'.repeat(100)][i], 500);
  assert.deepEqual(result.images, ['data:image/jpeg;base64,first', images[1]]);
  assert.equal(result.prompt, input.prompt);
  assert.equal(input.images, images);
  assert.ok(referenceBodyBytes(result) < 500);
});
test('request byte calculation includes UTF-8 prompt and reference sounds', async () => {
  const input = {...base, prompt: '图'.repeat(500), images: ['data:image/png;base64,a'], sounds: ['data:audio/mpeg;base64,b']};
  assert.ok(referenceBodyBytes(input) > 1500);
  await assert.rejects(fitReferenceImages(input, async () => 'data:image/jpeg;base64,a', 500), /未提交上游/);
});
test('FFmpeg transport JPEG preserves dimensions and never changes original bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-reference-test-'));
  t.after(async () => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dir).startsWith('mv-reference-test-'));
    await fs.rm(dir, {recursive: true, force: true});
  });
  const source = path.join(dir, 'source.png'), output = path.join(dir, 'transport.jpg');
  await run(binaries().ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=144x256', '-frames:v', '1', source]);
  const hash = async () => createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const before = await hash();
  const uri = await referenceJpeg(source);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
  await fs.writeFile(output, Buffer.from(uri.split(',')[1], 'base64'));
  const metadata = await probe(output);
  assert.equal(metadata.streams[0].width, 144);
  assert.equal(metadata.streams[0].height, 256);
  assert.equal(await hash(), before);
});
