'use strict';

const QR_SIZE = 360;
const CARD_WIDTH = 430;
const CARD_HEIGHT = 500;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function inviteCaption(expiresAt) {
  if (!Number.isFinite(expiresAt)) {
    throw new Error('缺少有效期');
  }
  const deadline = new Date(expiresAt + CHINA_OFFSET_MS);
  return {
    dateLabel: `${deadline.getUTCFullYear()}-${pad(deadline.getUTCMonth() + 1)}-${pad(deadline.getUTCDate())} ${pad(deadline.getUTCHours())}:${pad(deadline.getUTCMinutes())}`,
    validityLabel: '24 小时有效',
  };
}

function drawInviteCard(ctx, { image, caption }) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.drawImage(image, (CARD_WIDTH - QR_SIZE) / 2, 16, QR_SIZE, QR_SIZE);
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '28px sans-serif';
  ctx.fillText(caption.dateLabel, CARD_WIDTH / 2, QR_SIZE + 40);
  ctx.font = '24px sans-serif';
  ctx.fillText(caption.validityLabel, CARD_WIDTH / 2, QR_SIZE + 84);
}

function writeBase64(wxApi, filePath, imageBase64) {
  return new Promise((resolve, reject) => {
    wxApi.getFileSystemManager().writeFile({
      filePath,
      data: imageBase64,
      encoding: 'base64',
      success: resolve,
      fail: reject,
    });
  });
}

function loadCanvasImage(canvas, src) {
  const image = canvas.createImage();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('邀请图读取失败'));
    image.src = src;
  });
}

function exportCanvas(wxApi, canvas) {
  return new Promise((resolve, reject) => {
    wxApi.canvasToTempFilePath({
      canvas,
      fileType: 'png',
      destWidth: CARD_WIDTH,
      destHeight: CARD_HEIGHT,
      success: (result) => resolve(result.tempFilePath),
      fail: reject,
    });
  });
}

function saveToAlbum(wxApi, filePath) {
  return new Promise((resolve, reject) => {
    wxApi.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: reject,
    });
  });
}

function pixelRatio(wxApi) {
  const info = wxApi.getWindowInfo
    ? wxApi.getWindowInfo()
    : wxApi.getSystemInfoSync && wxApi.getSystemInfoSync();
  const ratio = info && info.pixelRatio;
  return ratio > 0 ? ratio : 2;
}

function loadInviteCanvas(wxApi, page) {
  return new Promise((resolve, reject) => {
    wxApi
      .createSelectorQuery()
      .in(page)
      .select('#invite-card')
      .fields({ node: true, size: true })
      .exec((result) => {
        const canvas = result && result[0] && result[0].node;
        if (!canvas) {
          reject(new Error('邀请图画布不可用'));
          return;
        }
        resolve(canvas);
      });
  });
}

async function renderInviteCard(wxApi, page, { imageBase64, expiresAt }) {
  const caption = inviteCaption(expiresAt);
  const canvas = await loadInviteCanvas(wxApi, page);
  const ratio = pixelRatio(wxApi);
  canvas.width = CARD_WIDTH * ratio;
  canvas.height = CARD_HEIGHT * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  const qrPath = `${wxApi.env.USER_DATA_PATH}/admin-invite-qr.jpg`;
  await writeBase64(wxApi, qrPath, imageBase64);
  const image = await loadCanvasImage(canvas, qrPath);
  drawInviteCard(context, { image, caption });
  const cardPath = await exportCanvas(wxApi, canvas);
  await saveToAlbum(wxApi, cardPath);
}

module.exports = {
  CARD_HEIGHT,
  CARD_WIDTH,
  QR_SIZE,
  drawInviteCard,
  inviteCaption,
  renderInviteCard,
};
