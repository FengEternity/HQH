'use strict';

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
}

function isReadyToPublish(doc) {
  try {
    assertReadyToPublish(doc);
    return true;
  } catch (error) {
    return false;
  }
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
  nextStatusAfterSave,
};
