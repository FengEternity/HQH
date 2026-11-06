const { agent, catalog, search } = require('../../utils/api');
const { searchNoticeText } = require('./searchNotice');
const { withPosterUrls } = require('../../utils/videoMedia');
const { saveSearchMissDraft } = require('../../utils/searchMissDraft');
const { whenCloudReady } = require('../../utils/cloudReady');
const {
  callWithVisitorRetry,
  visitorCatalogMessage,
} = require('../../utils/catalogVisitorError');

const HOME_CACHE_MS = 60000;

function decorateSearchItems(items) {
  return withPosterUrls(items || []).map((item) =>
    Object.assign({}, item, {
      initial: String(item.brandName || '优').slice(0, 1),
    }),
  );
}

Page({
  data: {
    brands: [],
    allVideos: [],
    shelves: [],
    results: [],
    searchItems: [],
    keywordItems: [],
    keywordResults: [],
    brandId: '',
    query: '',
    queryMode: 'keyword',
    searched: false,
    searching: false,
    searchMode: '',
    aiLabel: '',
    notice: '',
    noticeText: '',
    agentMerged: false,
    loading: true,
    error: '',
  },
  // 正式版发布后删除：连点标题八次进入运营登录。
  tapCount: 0,
  onLoad() {
    whenCloudReady(getApp()).then(() => this.load({ showLoading: true }));
  },
  onShow() {
    if (!this._loadedOnce) return;
    if (this._homeLoadedAt && Date.now() - this._homeLoadedAt < HOME_CACHE_MS) return;
    this.load({ showLoading: false });
  },
  load(options) {
    const showLoading = !options || options.showLoading !== false;
    const hasContent = (this.data.shelves && this.data.shelves.length) || this.data.brands.length;
    const seq = (this._loadSeq || 0) + 1;
    this._loadSeq = seq;
    if (showLoading || !hasContent) {
      this.setData({ loading: true, error: '' });
    } else {
      this.setData({ error: '' });
    }
    // 一次云函数取齐品牌+视频，避免低并发环境两次 callFunction 排队。
    // 短暂失败再静默请求一次；未部署或依赖缺失不会因为重试变好。
    return callWithVisitorRetry(() => catalog({ action: 'listHome' }))
      .then((res) => {
        if (seq !== this._loadSeq) {
          return;
        }
        const brands = res.brands || [];
        const allVideos = withPosterUrls(res.videos || []);
        this._loadedOnce = true;
        this._homeLoadedAt = Date.now();
        this.setData({ brands, allVideos, loading: false, error: '' });
        this.paintShelves();
      })
      .catch((err) => {
        if (seq !== this._loadSeq) {
          return;
        }
        console.error('listHome failed', err);
        const message = visitorCatalogMessage('load');
        if (!showLoading && hasContent) {
          this.setData({ loading: false });
          wx.showToast({ title: message, icon: 'none' });
          return;
        }
        this.setData({ loading: false, error: message });
      });
  },
  onRetry() {
    return this.load({ showLoading: true });
  },
  paintShelves() {
    const brandId = this.data.brandId;
    const brands = this.data.brands;
    const videos = this.data.allVideos.filter((item) => !brandId || item.brandId === brandId);
    const shelves = brands
      .filter((brand) => !brandId || brand._id === brandId)
      .map((brand) => ({
        id: brand._id,
        brand: Object.assign({}, brand, { initial: String(brand.name || '优').slice(0, 1) }),
        items: videos.filter((item) => item.brandId === brand._id),
      }))
      .filter((shelf) => shelf.items.length);
    this.setData({
      shelves,
      searched: false,
      results: [],
      searchItems: [],
      keywordItems: [],
      keywordResults: [],
      searchMode: '',
      aiLabel: '',
      notice: '',
      noticeText: '',
      agentMerged: false,
    });
  },
  paintSearchResults() {
    const brandId = this.data.brandId;
    const match = (item) => !brandId || item.brandId === brandId;
    this.setData({
      results: (this.data.searchItems || []).filter(match),
      keywordResults: (this.data.keywordItems || []).filter(match),
    });
  },
  onQuery(e) {
    this.setData({ query: e.detail.value });
  },
  onModeTap() {
    if (this.data.searching) {
      return;
    }
    this.setData({ queryMode: this.data.queryMode === 'ai' ? 'keyword' : 'ai' });
  },
  onSearchConfirm() {
    const queryMode = this.data.queryMode === 'ai' ? 'ai' : 'keyword';
    return this.submitSearch(queryMode);
  },
  onSearchMiss() {
    saveSearchMissDraft(this.data.query);
    wx.switchTab({ url: '/pages/contact/contact' });
  },
  submitSearch(mode) {
    const query = (this.data.query || '').trim();
    if (this.data.searching) {
      return;
    }
    if (!query) {
      this.paintShelves();
      return;
    }
    const searchMode = mode === 'ai' ? 'ai' : 'keyword';
    const seq = (this._searchSeq || 0) + 1;
    this._searchSeq = seq;
    this.setData({ searching: true, error: '' });
    const request = () => {
      if (searchMode !== 'ai') {
        return search({ scene: 'video', query, mode: searchMode }).then((ai) => ({ ai }));
      }
      return agent({ action: 'videoSearch', query })
        .then((agentResult) => {
          if (!agentResult || !Array.isArray(agentResult.items)) {
            throw new Error('agent_unavailable');
          }
          return { agentResult };
        })
        .catch(() => search({ scene: 'video', query, mode: 'ai' }).then((ai) => ({ ai })));
    };
    return callWithVisitorRetry(request)
      .then(({ ai, agentResult }) => {
        if (seq !== this._searchSeq) {
          return;
        }
        if (agentResult) {
          const searchItems = decorateSearchItems(agentResult.items);
          const notice = agentResult.notice || '';
          this.setData({
            searchItems,
            keywordItems: [],
            searchMode,
            aiLabel: 'AI 搜索结果',
            notice,
            noticeText: searchNoticeText(notice, searchItems),
            searching: false,
            searched: true,
            error: '',
            agentMerged: true,
          });
          this.paintSearchResults();
          return;
        }
        const merged = decorateSearchItems(ai.items);
        const hasSplit = searchMode === 'ai' && Array.isArray(ai.keywordItems) && Array.isArray(ai.semanticOnlyItems);
        const keywordItems = hasSplit ? decorateSearchItems(ai.keywordItems) : (searchMode === 'ai' ? merged : []);
        const searchItems = searchMode === 'ai'
          ? (hasSplit ? decorateSearchItems(ai.semanticOnlyItems) : [])
          : merged;
        const notice = searchMode === 'ai' ? (ai.notice || '') : '';
        const noticeItems = keywordItems.length ? keywordItems : searchItems;
        this.setData({
          searchItems,
          keywordItems,
          searchMode,
          aiLabel: searchMode === 'ai' ? 'AI 搜索结果' : '',
          notice,
          noticeText: searchMode === 'ai' ? searchNoticeText(notice, noticeItems) : '',
          searching: false,
          searched: true,
          error: '',
          agentMerged: false,
        });
        this.paintSearchResults();
      })
      .catch((err) => {
        if (seq !== this._searchSeq) {
          return;
        }
        console.error('search failed', err);
        const stillEmpty =
          !(this.data.shelves && this.data.shelves.length) && !this.data.brands.length;
        this.setData({
          searching: false,
          error: stillEmpty ? visitorCatalogMessage('load') : '',
        });
        wx.showToast({
          title: searchMode === 'ai' ? '搜索失败，请重试' : visitorCatalogMessage('search'),
          icon: 'none',
        });
      });
  },
  onBrandTap(e) {
    const id = e.currentTarget.dataset.id || '';
    this.setData({ brandId: id });
    const query = (this.data.query || '').trim();
    if (!query || !this.data.searched) {
      if (!this.data.searching) {
        this.paintShelves();
      }
      return;
    }
    this.paintSearchResults();
  },
  onVideoTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/player/player?id=${id}` });
  },
  onTitleTap() {
    this.tapCount += 1;
    if (this.tapCount >= 8) {
      this.tapCount = 0;
      wx.navigateTo({ url: '/pages/admin/login/login' });
    }
  },
});
