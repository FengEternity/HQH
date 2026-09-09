function formatPriceYuan(priceFen) {
  const fen = Number(priceFen);
  if (!Number.isFinite(fen)) {
    return '0.0';
  }
  return (fen / 100).toFixed(1);
}

function yuanToFen(yuanText) {
  const n = Number(String(yuanText || '').trim());
  if (!Number.isFinite(n) || n < 0) {
    return NaN;
  }
  return Math.round(n * 100);
}

module.exports = {
  formatPriceYuan,
  yuanToFen,
};
