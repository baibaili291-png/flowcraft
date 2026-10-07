/*
 * store.js —— 持久化（localStorage + 导入/导出）。
 * 纯前端即可用，刷新不丢；导出/导入 JSON 方便分享工作流。
 */
(function (global) {
  'use strict';

  const KEY = 'flowcraft:workflow:v1';

  const Store = {
    save(graph) {
      try {
        localStorage.setItem(KEY, JSON.stringify(graph.toJSON()));
      } catch (_) {
        /* 隐私模式或配额满时静默失败，不影响运行 */
      }
    },
    load(graph) {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return false;
        graph.load(JSON.parse(raw));
        return true;
      } catch (_) {
        return false;
      }
    },
    export(graph) {
      return JSON.stringify(graph.toJSON(), null, 2);
    },
    import(graph, text) {
      const json = JSON.parse(text);
      graph.load(json);
    },
  };

  global.FC = global.FC || {};
  global.FC.Store = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Store };
})(typeof window !== 'undefined' ? window : globalThis);
