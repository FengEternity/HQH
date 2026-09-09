'use strict';

/**
 * 首页一次取齐品牌 + 已上架视频，避免客户端并发两次 callFunction
 * 在低并发云函数环境里互相排队。
 */
async function listHomeCatalog({ listBrands, listPublished }) {
  if (typeof listBrands !== 'function' || typeof listPublished !== 'function') {
    throw new Error('listHomeCatalog requires listBrands and listPublished');
  }
  const [brandsRes, videosRes] = await Promise.all([listBrands(), listPublished({})]);
  return {
    ok: true,
    brands: (brandsRes && brandsRes.brands) || [],
    videos: (videosRes && videosRes.videos) || [],
  };
}

module.exports = {
  listHomeCatalog,
};
