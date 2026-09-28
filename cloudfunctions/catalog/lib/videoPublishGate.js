'use strict';

const { PLACEHOLDER_INTRO } = require('./videoIngest');

function fail(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  throw err;
}

function assertVideoDraftFields(doc) {
  const title = String((doc && doc.title) || '').trim();
  const intro = String((doc && doc.intro) || '').trim();
  const brandId = String((doc && doc.brandId) || '').trim();
  if (!title || !intro || !brandId) {
    fail('标题、品牌与简介必填');
  }
}

function assertReadyToPublish(doc) {
  assertVideoDraftFields(doc);
  const coverFileId = String((doc && doc.coverFileId) || '').trim();
  const videoFileId = String((doc && doc.videoFileId) || '').trim();
  if (!coverFileId || !videoFileId) {
    fail('上架前请先上传封面和视频');
  }
  if (doc?.ingest?.phase !== 'ready') fail('视频处理完成前不能上架');
  if (doc.ingest.videoFileId !== doc.videoFileId) fail('视频文件尚未完成处理');
  if (doc?.media?.playback?.compliant !== true) fail('视频未通过播放规格检查');
  if (String((doc && doc.intro) || '').trim() === PLACEHOLDER_INTRO) {
    fail('上架前请先补写简介');
  }
}

function isReadyToPublish(doc) {
  try {
    assertReadyToPublish(doc);
    return true;
  } catch (error) {
    return false;
  }
}

async function publishReadyVideo({ repository, id, checkText, now }) {
  return await repository.runTransaction(async (transaction) => {
    const doc = await transaction.getVideo(id);
    if (!doc) {
      const error = new Error('NOT_FOUND');
      error.code = 'NOT_FOUND';
      throw error;
    }
    assertReadyToPublish(doc);
    await checkText(`${doc.title}\n${doc.intro}`);
    const timestamp = now();
    await transaction.updateVideo(id, {
      status: 'published',
      publishedAt: timestamp,
      updatedAt: timestamp,
    });
    return { ok: true };
  });
}

function nextStatusAfterSave(prevStatus) {
  if (prevStatus === 'published') {
    return 'published';
  }
  if (prevStatus === 'unpublished') {
    return 'unpublished';
  }
  return 'draft';
}

module.exports = {
  assertVideoDraftFields,
  assertReadyToPublish,
  isReadyToPublish,
  publishReadyVideo,
  nextStatusAfterSave,
};
