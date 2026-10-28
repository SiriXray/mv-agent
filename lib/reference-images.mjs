import {buildRequest} from './providers.mjs';
import {check} from './core.mjs';
import {run, binaries} from './media.mjs';

export const MAX_REFERENCE_BODY = 20 * 1024 * 1024;
export const referenceBodyBytes = input => Buffer.byteLength(JSON.stringify(buildRequest('vidu-q4', input).body));

// Encode a transport copy only. No resize, crop, or write to the original file.
export async function referenceJpeg(file, signal, env = process.env) {
  const data = await run(binaries(env).ffmpeg, [
    '-nostdin', '-v', 'error', '-i', file, '-frames:v', '1',
    '-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p', '-f', 'image2pipe', 'pipe:1',
  ], {signal, maxBytes: MAX_REFERENCE_BODY});
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}

export async function fitReferenceImages(input, encode, maxBytes = MAX_REFERENCE_BODY) {
  if (referenceBodyBytes(input) < maxBytes) return input;
  const images = [...input.images];
  // Keep reference order and use the compressed representation only if smaller.
  for (let i = 0; i < images.length; i++) {
    const jpeg = await encode(i);
    if (jpeg.length < images[i].length) images[i] = jpeg;
  }
  const fitted = {...input, images};
  check(referenceBodyBytes(fitted) < maxBytes, '参考图片压缩后请求体仍超过 20MB，请减少每镜引用或缩小图片；未提交上游', 422);
  return fitted;
}
