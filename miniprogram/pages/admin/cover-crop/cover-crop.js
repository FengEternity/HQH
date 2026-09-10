'use strict';

const {
  clampScale,
  clampOffset,
  initialView,
  sourceRect,
  isSmallCover,
  minScale,
  EXPORT_WIDTH,
  EXPORT_HEIGHT,
} = require('../../../utils/coverCrop');

function pinchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function touchCenter(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function decodeSource(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_err) {
    return String(value || '');
  }
}

Page({
  data: {
    src: '',
    imgW: 1,
    imgH: 1,
    frameW: 1,
    frameH: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    displayW: 1,
    displayH: 1,
  },

  onLoad(query) {
    this.eventChannel = this.getOpenerEventChannel();
    this.eventChannel.on('init', ({ src }) => this.loadSource(src));
    const querySource = decodeSource(query && query.src);
    if (querySource) {
      this.loadSource(querySource);
    }
  },

  onUnload() {
    this.emitCancel();
  },

  loadSource(src) {
    if (!src) {
      wx.showToast({ title: '没有可裁剪的图片', icon: 'none' });
      return;
    }
    if (this.loadingSource === src || this.loadedSource === src) {
      return;
    }
    this.loadingSource = src;
    wx.getImageInfo({
      src,
      success: ({ width, height }) => {
        this.loadedSource = src;
        this.loadingSource = '';
        this.setData({ src, imgW: width, imgH: height }, () => {
          this.measureFrame()
            .then((frame) => {
              this.frameLeft = frame.left;
              this.frameTop = frame.top;
              this.setData({ frameW: frame.width, frameH: frame.height });
              this.applyView(initialView(width, height, frame.width, frame.height));
              if (isSmallCover(width, height)) {
                wx.showToast({ title: '原图偏小，首页可能发糊', icon: 'none' });
              }
            })
            .catch(() => wx.showToast({ title: '裁剪框初始化失败', icon: 'none' }));
        });
      },
      fail: () => {
        this.loadingSource = '';
        wx.showToast({ title: '图片读取失败', icon: 'none' });
      },
    });
  },

  measureFrame() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('.crop-frame')
        .boundingClientRect((rect) => {
          if (!rect || !rect.width || !rect.height) {
            reject(new Error('CROP_FRAME_MISSING'));
            return;
          }
          resolve(rect);
        })
        .exec();
    });
  },

  applyView(view) {
    const minimum = minScale(
      this.data.imgW,
      this.data.imgH,
      this.data.frameW,
      this.data.frameH,
    );
    const scale = clampScale(view.scale, minimum);
    const offset = clampOffset(
      view.offsetX,
      view.offsetY,
      scale,
      this.data.imgW,
      this.data.imgH,
      this.data.frameW,
      this.data.frameH,
    );
    this.view = { scale, offsetX: offset.offsetX, offsetY: offset.offsetY };
    this.setData({
      scale,
      offsetX: offset.offsetX,
      offsetY: offset.offsetY,
      displayW: this.data.imgW * scale,
      displayH: this.data.imgH * scale,
    });
  },

  onReset() {
    if (!this.data.src) {
      return;
    }
    this.applyView(
      initialView(
        this.data.imgW,
        this.data.imgH,
        this.data.frameW,
        this.data.frameH,
      ),
    );
  },

  onTouchStart(event) {
    if (!this.view || this.frameLeft == null) {
      return;
    }
    const touches = event.touches || [];
    if (touches.length >= 2) {
      this.startPinch(touches);
      return;
    }
    if (touches.length === 1) {
      this.startDrag(touches[0]);
    }
  },

  onTouchMove(event) {
    if (!this.view || this.frameLeft == null) {
      return;
    }
    const touches = event.touches || [];
    if (touches.length >= 2) {
      if (!this.gesture || this.gesture.kind !== 'pinch') {
        this.startPinch(touches);
      }
      const center = touchCenter(touches);
      const scale = clampScale(
        this.gesture.scale * (pinchDistance(touches) / this.gesture.distance),
        this.gesture.minimum,
      );
      this.applyView({
        scale,
        offsetX:
          center.x - this.frameLeft - this.gesture.sourceX * scale,
        offsetY:
          center.y - this.frameTop - this.gesture.sourceY * scale,
      });
      return;
    }
    if (touches.length === 1) {
      if (!this.gesture || this.gesture.kind !== 'drag') {
        this.startDrag(touches[0]);
      }
      this.applyView({
        scale: this.gesture.scale,
        offsetX: this.gesture.offsetX + touches[0].clientX - this.gesture.x,
        offsetY: this.gesture.offsetY + touches[0].clientY - this.gesture.y,
      });
    }
  },

  onTouchEnd(event) {
    const touches = event.touches || [];
    if (touches.length >= 2) {
      this.startPinch(touches);
    } else if (touches.length === 1) {
      this.startDrag(touches[0]);
    } else {
      this.gesture = null;
    }
  },

  startDrag(touch) {
    const view = this.view || this.data;
    this.gesture = {
      kind: 'drag',
      x: touch.clientX,
      y: touch.clientY,
      scale: view.scale,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
    };
  },

  startPinch(touches) {
    const view = this.view || this.data;
    const center = touchCenter(touches);
    this.gesture = {
      kind: 'pinch',
      distance: Math.max(1, pinchDistance(touches)),
      minimum: minScale(
        this.data.imgW,
        this.data.imgH,
        this.data.frameW,
        this.data.frameH,
      ),
      scale: view.scale,
      sourceX: (center.x - this.frameLeft - view.offsetX) / view.scale,
      sourceY: (center.y - this.frameTop - view.offsetY) / view.scale,
    };
  },

  onCancel() {
    this.emitCancel();
    wx.navigateBack();
  },

  emitCancel() {
    if (this.finished || this.cancelled || !this.eventChannel) {
      return;
    }
    this.cancelled = true;
    this.eventChannel.emit('cancel');
  },

  onConfirm() {
    if (!this.data.src || !this.view || this.exporting) {
      return;
    }
    this.exporting = true;
    wx.showLoading({ title: '正在生成' });
    this.exportCover()
      .then((path) => {
        wx.hideLoading();
        this.finished = true;
        this.eventChannel.emit('done', { path });
        wx.navigateBack();
      })
      .catch(() => {
        wx.hideLoading();
        this.exporting = false;
        wx.showToast({ title: '导出失败', icon: 'none' });
      });
  },

  exportCover() {
    return this.getCanvas().then(({ canvas, context }) => {
      const rect = sourceRect(
        this.view.offsetX,
        this.view.offsetY,
        this.view.scale,
        this.data.imgW,
        this.data.imgH,
        this.data.frameW,
        this.data.frameH,
      );
      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('CROP_EXPORT_TIMEOUT'));
          }
        }, 8000);
        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          callback(value);
        };
        const image = canvas.createImage();
        image.onload = () => {
          context.clearRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
          context.drawImage(
            image,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            0,
            0,
            EXPORT_WIDTH,
            EXPORT_HEIGHT,
          );
          setTimeout(() => {
            try {
              wx.canvasToTempFilePath({
                canvas,
                fileType: 'jpg',
                quality: 0.8,
                destWidth: EXPORT_WIDTH,
                destHeight: EXPORT_HEIGHT,
                success: (result) => finish(resolve, result.tempFilePath),
                fail: (err) => finish(reject, err),
              });
            } catch (err) {
              finish(reject, err);
            }
          }, 16);
        };
        image.onerror = (err) => finish(reject, err);
        image.src = this.data.src;
      });
    });
  },

  getCanvas() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#cropCanvas')
        .fields({ node: true, size: true })
        .exec((result) => {
          const canvas = result && result[0] && result[0].node;
          if (!canvas) {
            reject(new Error('CROP_CANVAS_MISSING'));
            return;
          }
          canvas.width = EXPORT_WIDTH;
          canvas.height = EXPORT_HEIGHT;
          resolve({ canvas, context: canvas.getContext('2d') });
        });
    });
  },
});
