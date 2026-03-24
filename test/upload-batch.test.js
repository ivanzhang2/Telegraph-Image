const test = require('node:test');
const assert = require('node:assert/strict');

async function getUploadModule() {
  return import('../functions/upload.js');
}

test('single file result is normalized as array item', async () => {
  const { formatUploadResult } = await getUploadModule();

  const result = formatUploadResult('file-id-1', 'a.jpg', 'image/jpeg');

  assert.deepEqual(result, {
    src: '/file/file-id-1.jpg',
    fileName: 'a.jpg',
    mimeType: 'image/jpeg',
  });
});

test('media group messages return multiple upload results', async () => {
  const { extractMediaGroupResults } = await getUploadModule();

  const result = extractMediaGroupResults({
    ok: true,
    result: [
      {
        photo: [
          { file_id: 'small-1', file_size: 1 },
          { file_id: 'large-1', file_size: 10 },
        ],
      },
      {
        video: {
          file_id: 'video-2',
        },
      },
    ],
  }, [
    { name: 'a.jpg', type: 'image/jpeg' },
    { name: 'b.mp4', type: 'video/mp4' },
  ]);

  assert.deepEqual(result, [
    {
      src: '/file/large-1.jpg',
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
    },
    {
      src: '/file/video-2.mp4',
      fileName: 'b.mp4',
      mimeType: 'video/mp4',
    },
  ]);
});

test('shouldUseMediaGroup only accepts 2-10 image/video files', async () => {
  const { shouldUseMediaGroup } = await getUploadModule();

  assert.equal(shouldUseMediaGroup([{ type: 'image/jpeg' }]), false);
  assert.equal(
    shouldUseMediaGroup([{ type: 'image/jpeg' }, { type: 'video/mp4' }]),
    true
  );
  assert.equal(
    shouldUseMediaGroup([{ type: 'image/jpeg' }, { type: 'application/json' }]),
    false
  );
});
