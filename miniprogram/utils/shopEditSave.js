'use strict';

/**
 * Build upsertShopProduct payload for admin shop-edit.
 * Never persist until the page finished a successful hydrate.
 * Only attach videoIds after the video checklist loaded (explicit [] clears links).
 */
function buildUpsertShopProductRequest({
  hydrated,
  linksReady,
  id,
  fields,
  selectedVideoIds,
}) {
  if (!hydrated) {
    return { ok: false, code: 'NOT_HYDRATED' };
  }
  const data = Object.assign(
    {
      action: 'upsertShopProduct',
      id: id ? id : undefined,
    },
    fields || {},
  );
  if (linksReady) {
    data.videoIds = Array.isArray(selectedVideoIds) ? selectedVideoIds : [];
  }
  return { ok: true, data };
}

module.exports = {
  buildUpsertShopProductRequest,
};
