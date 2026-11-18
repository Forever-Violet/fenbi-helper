// ==UserScript==
// @name         粉笔助手 · 解析与题目讨论
// @namespace    https://github.com/fenbi-helper
// @version      1.2.4
// @description  集成「自动展开解析」「题目讨论」「专注模式」与统一设置面板；解析页与错题本/背题页均可在每题下方展开评论区，支持高赞/最新排序、分页加载、一键批量展开。v1.2.4 修复答题后单题请求覆盖整页题号的问题。基于原「自动展开答案解析 v3.0」重构。
// @author       飞行雪绒
// @match        *://*.fenbi.com/ti/*
// @match        https://www.fenbi.com/spa/tiku/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      tiku.fenbi.com
// @connect      ke.fenbi.com
// @license      MIT
// ==/UserScript==

/*
 * 架构
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 基础设施  Settings / EventBus / DOM 调度 / UI Kit / HTTP      │
 * │ 数据服务  DataService：请求旁路捕获 + 接口兜底 + 三级缓存      │
 * │ 功能模块  Feature[]：autoExpand / comments / focusMode         │
 * │ 控制入口  悬浮面板 + 油猴菜单 + 快捷键                        │
 * └──────────────────────────────────────────────────────────────┘
 * 新增功能只需往 FEATURES 里追加一个实现了 apply/onDom 的对象。
 *
 * 评论数据链路：
 *   questionKey(DOM: app-ti[data-question-key] / section-solution-*)
 *     → 数字题号 tikuId（页面自身接口响应 or /combine/exercise/getSolution）
 *     → episodeId（/api/gwy/v3/episodes/tiku_episodes_with_multi_type）
 *     → 评论列表（/ipad/gwy/v3/comments/episodes/{episodeId}）
 */

(function () {
    'use strict';

    /* ==============================================================
     * 1. 常量
     * ============================================================== */

    const TAG = '[粉笔助手]';
    const VERSION = '1.2.4';
    const SETTINGS_KEY = 'fbh.settings.v1';
    const KEY_RE = /^[0-9a-z]{1,4}(?:_[0-9a-z]+)+$/i;
    const COMMENT_QS = 'system=12.4.7&inhouse=0&app=gwy&ua=iPad&av=44&version=6.11.3&kav=22';

    const DEFAULTS = Object.freeze({
        autoExpand: true,   // 自动展开解析面板
        comments: true,     // 题目讨论总开关
        quickEntry: true,   // 题目标题栏快捷入口
        focusMode: false,   // 专注模式：隐藏视频 / 推广 / 统计卡
        sort: 'hot',        // hot | new
        pageSize: 20,       // 每次加载条数
        qualityOnly: false, // 只看优质评论
        debug: false
    });

    const ICONS = {
        bubble: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9.6L4.8 20.4A1 1 0 0 1 3 19.6V16.9A2 2 0 0 1 2 15V5a2 2 0 0 1 2-2zm3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm5 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm5 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
        like: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
        logo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5L12 3z"/><path d="M3 12l9 4.5L21 12"/><path d="M3 16.5 12 21l9-4.5"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    };

    /* ==============================================================
     * 2. 基础设施：配置 / 事件 / DOM 工具 / 样式 / 网络
     * ============================================================== */

    const PAGE_WINDOW = (() => {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.XMLHttpRequest) return unsafeWindow;
        } catch (e) { /* 忽略：退回脚本 window */ }
        return window;
    })();

    const isObj = (v) => v !== null && typeof v === 'object';
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const $ = (sel, root) => (root || document).querySelector(sel);
    const firstString = (...vals) => vals.find((v) => typeof v === 'string' && v.trim()) || '';
    const numericId = (v) => (/^\d{4,13}$/.test(String(v == null ? '' : v).trim()) ? String(v).trim() : '');

    function readSettings() {
        try {
            const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, '') : localStorage.getItem(SETTINGS_KEY);
            const saved = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (isObj(raw) ? raw : {});
            return Object.assign({}, DEFAULTS, saved);
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }

    const settings = readSettings();

    function saveSettings() {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
            else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* 隐私模式下忽略 */ }
    }

    const bus = (() => {
        const map = new Map();
        return {
            on(evt, fn) {
                if (!map.has(evt)) map.set(evt, []);
                map.get(evt).push(fn);
            },
            emit(evt, payload) {
                (map.get(evt) || []).forEach((fn) => {
                    try { fn(payload); } catch (e) { warn('事件处理异常', evt, e); }
                });
            }
        };
    })();

    function log(...args) { if (settings.debug) console.log(TAG, ...args); }
    function warn(...args) { if (settings.debug) console.warn(TAG, ...args); }

    /** 极简 hyperscript：只用于本脚本自建 DOM，用户内容一律走 text */
    function h(tag, props, children) {
        const node = document.createElement(tag);
        Object.entries(props || {}).forEach(([key, val]) => {
            if (val === null || val === undefined || val === false) return;
            if (key === 'class') node.className = val;
            else if (key === 'text') node.textContent = val;
            else if (key === 'html') node.innerHTML = val;
            else if (key === 'dataset') Object.assign(node.dataset, val);
            else if (key === 'style') Object.assign(node.style, val);
            else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
            else node.setAttribute(key, val === true ? '' : val);
        });
        [].concat(children || []).forEach((child) => {
            if (child === null || child === undefined || child === false) return;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    }

    function debounce(fn, wait) {
        let timer = null;
        const wrapped = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => { timer = null; fn(...args); }, wait);
        };
        return wrapped;
    }

    const STYLE = `
:root {
  --fbh-bg: var(--color-bg-result-common, #ffffff);
  --fbh-surface: var(--color-bg-setting, #ffffff);
  --fbh-card: var(--color-bg-section, #f7f8fb);
  --fbh-text: var(--color-text-primary, #2b3138);
  --fbh-sub: var(--color-text-secondary, #868ea8);
  --fbh-border: var(--color-border-result-common, #e7eaf1);
  --fbh-chip: var(--color-bg-result-common-btn, #f1f3f8);
  --fbh-chip-on: var(--color-bg-result-common-btn-active, #e9f0ff);
  --fbh-chip-on-text: var(--color-text-result-common-btn-active, #3c7cfc);
  --fbh-accent: var(--color-text-blue, #3c7cfc);
  --fbh-shadow: 0 10px 32px rgba(25, 38, 68, .14);
}
:root.dark {
  --fbh-bg: var(--color-bg-result-common, #20232b);
  --fbh-surface: var(--color-bg-setting, #24272f);
  --fbh-card: var(--color-bg-section, #1b1e25);
  --fbh-text: var(--color-text-primary, #e7eaf2);
  --fbh-sub: var(--color-text-secondary, #8a91a3);
  --fbh-border: var(--color-border-result-common, #343944);
  --fbh-chip: var(--color-bg-result-common-btn, #2d323d);
  --fbh-chip-on: var(--color-bg-result-common-btn-active, #2b3c60);
  --fbh-chip-on-text: var(--color-text-result-common-btn-active, #82a8ff);
  --fbh-accent: var(--color-text-blue, #6f9bff);
  --fbh-shadow: 0 12px 36px rgba(0, 0, 0, .42);
}

/* 自动展开解析：CSS 兜底，JS 清除内联样式为主 */
html.fbh-autoexpand .result-common-container-toggle[style*="height: 0px"] {
  height: auto !important;
  overflow: visible !important;
}
/* 专注模式 */
html.fbh-focus app-result-common section[id^="section-video-"],
html.fbh-focus app-solution-overall,
html.fbh-focus .member-container,
html.fbh-focus .floating-ad { display: none !important; }

/* 题目标题栏的快捷入口，尺寸对齐原生 tool 图标 */
.fbh-quick {
  width: 26px; height: 26px; margin-left: 14px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--fbh-sub); transition: color .15s ease, transform .15s ease;
  flex: none; list-style: none;
}
.fbh-quick svg { width: 26px; height: 26px; display: block; }
.fbh-quick:hover { color: var(--fbh-accent); transform: translateY(-1px); }
.fbh-quick.is-open { color: var(--fbh-accent); }

/* 解析面板内嵌的评论区 */
.fbh-section {
  margin-top: 4px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fbh-text); font-size: 14px; text-align: left;
}
/* 错题本 / 背题页：题卡没有解析容器，评论区独立成卡片，避免横向溢出 */
.fbh-section--standalone {
  display: block; box-sizing: border-box; width: auto; max-width: 100%;
  margin: 12px 24px 14px; padding: 10px 14px 12px;
  background: var(--fbh-card);
  border: 1px solid var(--fbh-border); border-radius: 10px;
}
.fbh-section--standalone .fbh-head { padding: 0 0 2px; }
.fbh-section--standalone .fbh-body { padding-top: 6px; }
.fbh-section--standalone .fbh-qnum { background: var(--fbh-bg); border: 1px solid var(--fbh-border); }
.fbh-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 2px 0; cursor: pointer; user-select: none; border-radius: 6px;
}
.fbh-head:focus-visible { outline: 2px solid var(--fbh-accent); outline-offset: 3px; }
.fbh-head-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fbh-head-main > svg { color: var(--fbh-accent); flex: none; }
.fbh-title { font-size: 16px; font-weight: 700; letter-spacing: .3px; }
.fbh-badge {
  font-size: 11px; font-weight: 600; line-height: 18px; min-width: 18px; padding: 0 6px;
  text-align: center; border-radius: 9px; background: var(--fbh-chip-on); color: var(--fbh-chip-on-text);
}
.fbh-badge[hidden] { display: none; }
.fbh-qnum {
  font-size: 11px; font-weight: 600; line-height: 18px; padding: 0 7px;
  border-radius: 5px; color: var(--fbh-sub); background: var(--fbh-chip);
  white-space: nowrap; flex: none;
}
.fbh-qnum[hidden] { display: none; }
.fbh-head-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.fbh-chip, .fbh-icon-btn, .fbh-copy {
  font-family: inherit; font-size: 12px; line-height: 1; border: 0; border-radius: 6px;
  background: var(--fbh-chip); color: var(--fbh-sub); cursor: pointer;
  transition: background .15s ease, color .15s ease, opacity .15s ease;
}
.fbh-chip { padding: 5px 10px; }
.fbh-chip:hover, .fbh-icon-btn:hover, .fbh-copy:hover { color: var(--fbh-accent); }
.fbh-chip.is-active { background: var(--fbh-chip-on); color: var(--fbh-chip-on-text); font-weight: 600; }
.fbh-icon-btn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; }
.fbh-chevron { display: inline-flex; color: var(--fbh-sub); transition: transform .22s ease; }
.fbh-section.is-open .fbh-chevron { transform: rotate(180deg); }
.fbh-section.is-open .fbh-icon-btn.is-spinning svg { animation: fbh-spin .8s linear infinite; }

.fbh-panel {
  display: grid; grid-template-rows: 0fr; pointer-events: none;
  transition: grid-template-rows .28s cubic-bezier(.2, .8, .2, 1);
}
.fbh-section.is-open .fbh-panel { grid-template-rows: 1fr; pointer-events: auto; }
.fbh-panel-inner { overflow: hidden; min-height: 0; }
.fbh-body { padding: 12px 0 2px; }

.fbh-state { padding: 22px 6px; text-align: center; color: var(--fbh-sub); font-size: 13px; line-height: 1.8; }
.fbh-state[hidden] { display: none; }
.fbh-diag { margin-top: 7px; font-size: 11px; line-height: 1.6; color: var(--fbh-sub); opacity: .85; word-break: break-all; }
.fbh-state-title { font-size: 13px; font-weight: 600; color: var(--fbh-text); margin-bottom: 4px; }
.fbh-retry {
  margin-top: 10px; padding: 6px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
  border: 1px solid var(--fbh-border); border-radius: 6px; background: transparent; color: var(--fbh-accent);
}
.fbh-skeleton { padding: 10px 0; }
.fbh-skeleton-row { display: flex; gap: 10px; margin-bottom: 14px; }
.fbh-sk-avatar { width: 30px; height: 30px; border-radius: 50%; flex: none; }
.fbh-sk-lines { flex: 1; }
.fbh-sk-line { height: 10px; border-radius: 5px; margin-bottom: 8px; }
.fbh-sk-line.short { width: 38%; }
.fbh-sk-avatar, .fbh-sk-line {
  background: linear-gradient(90deg, var(--fbh-chip) 25%, var(--fbh-card) 37%, var(--fbh-chip) 63%);
  background-size: 400% 100%; animation: fbh-shimmer 1.4s ease infinite;
}

.fbh-list { margin: 0; padding: 0; }
.fbh-item { display: flex; gap: 10px; padding: 12px 2px; border-bottom: 1px dashed var(--fbh-border); }
.fbh-item:last-child { border-bottom: 0; }
.fbh-avatar {
  position: relative; width: 30px; height: 30px; border-radius: 50%; flex: none; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--fbh-chip-on); color: var(--fbh-chip-on-text); font-size: 13px; font-weight: 700;
}
.fbh-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.fbh-item-main { min-width: 0; flex: 1; }
.fbh-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--fbh-sub); }
.fbh-name { color: var(--fbh-text); font-weight: 600; }
.fbh-stars { color: #f5a623; letter-spacing: 1px; }
.fbh-text { margin-top: 5px; font-size: 14px; line-height: 1.75; white-space: pre-wrap; word-break: break-word; }
.fbh-item-foot { display: flex; align-items: center; gap: 14px; margin-top: 7px; font-size: 12px; color: var(--fbh-sub); }
.fbh-like { display: inline-flex; align-items: center; gap: 4px; color: #ef8f2e; font-weight: 600; }
.fbh-copy { padding: 2px 4px; background: transparent; }
.fbh-hot { padding: 1px 6px; border-radius: 4px; background: #fff2e2; color: #e07d12; font-size: 11px; }
:root.dark .fbh-hot { background: #4a3418; color: #ffb659; }
.fbh-more {
  width: 100%; margin-top: 12px; padding: 9px; font-family: inherit; font-size: 13px; cursor: pointer;
  border: 1px solid var(--fbh-border); border-radius: 8px; background: transparent; color: var(--fbh-accent);
  transition: background .15s ease;
}
.fbh-more:hover { background: var(--fbh-chip-on); }
.fbh-more[hidden] { display: none; }
.fbh-foot { margin-top: 10px; text-align: right; font-size: 11px; color: var(--fbh-sub); opacity: .7; }

/* 悬浮控制面板 */
.fbh-dock {
  position: fixed; right: 22px; bottom: 96px; z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fbh-text); text-align: left;
}
.fbh-fab {
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 14px; cursor: pointer; color: #fff; background: var(--fbh-accent);
  box-shadow: 0 6px 20px rgba(60, 124, 252, .36); transition: transform .18s ease, box-shadow .18s ease;
}
.fbh-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(60, 124, 252, .46); }
.fbh-dock.is-open .fbh-fab { border-radius: 14px 14px 6px 14px; }
.fbh-dock-panel {
  display: none; position: absolute; right: 0; bottom: 56px; width: 306px;
  max-height: min(72vh, 600px); overflow-y: auto; box-sizing: border-box; padding: 15px 16px 12px;
  background: var(--fbh-surface); border: 1px solid var(--fbh-border); border-radius: 14px;
  box-shadow: var(--fbh-shadow); animation: fbh-in .18s ease both;
}
.fbh-dock.is-open .fbh-dock-panel { display: block; }
.fbh-dock-head { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--fbh-border); }
.fbh-dock-logo { color: var(--fbh-accent); display: inline-flex; }
.fbh-dock-title { font-size: 15px; font-weight: 700; flex: 1; }
.fbh-dock-version { font-size: 11px; color: var(--fbh-sub); }
.fbh-dock-close { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--fbh-sub); cursor: pointer; border-radius: 6px; }
.fbh-dock-close:hover { background: var(--fbh-chip); color: var(--fbh-text); }
.fbh-group { padding: 12px 0 4px; border-bottom: 1px solid var(--fbh-border); }
.fbh-group:last-of-type { border-bottom: 0; }
.fbh-group-title { font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--fbh-sub); margin-bottom: 6px; }
.fbh-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; }
.fbh-row-label { font-size: 13px; font-weight: 600; }
.fbh-row-desc { font-size: 11px; line-height: 1.5; color: var(--fbh-sub); margin-top: 2px; }
.fbh-switch { position: relative; width: 38px; height: 22px; flex: none; cursor: pointer; }
.fbh-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.fbh-switch i { display: block; width: 38px; height: 22px; border-radius: 22px; background: var(--fbh-chip); transition: background .18s ease; }
.fbh-switch i::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .2); transition: transform .18s ease;
}
.fbh-switch input:checked + i { background: var(--fbh-accent); }
.fbh-switch input:checked + i::after { transform: translateX(16px); }
.fbh-seg { display: flex; gap: 6px; }
.fbh-seg .fbh-chip { flex: 1; text-align: center; }
.fbh-select {
  font-family: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px;
  border: 1px solid var(--fbh-border); background: var(--fbh-card); color: var(--fbh-text); cursor: pointer;
}
.fbh-actions { display: flex; gap: 8px; margin: 10px 0 4px; }
.fbh-action {
  flex: 1; padding: 8px 4px; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  border: 1px solid var(--fbh-border); border-radius: 8px; background: var(--fbh-card); color: var(--fbh-text);
  transition: background .15s ease, color .15s ease;
}
.fbh-action:hover { background: var(--fbh-chip-on); color: var(--fbh-chip-on-text); }
.fbh-status { padding-top: 10px; font-size: 11px; line-height: 1.7; color: var(--fbh-sub); }
.fbh-reset { margin-top: 8px; padding: 0; border: 0; background: transparent; color: var(--fbh-sub); font-family: inherit; font-size: 11px; text-decoration: underline; cursor: pointer; }

.fbh-toast-host {
  position: fixed; top: 74px; left: 50%; transform: translateX(-50%); z-index: 2147483600;
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.fbh-toast {
  max-width: 420px; padding: 9px 16px; border-radius: 8px; font-size: 13px; line-height: 1.5;
  background: var(--fbh-surface); color: var(--fbh-text); border: 1px solid var(--fbh-border);
  box-shadow: var(--fbh-shadow); animation: fbh-in .2s ease both;
}
.fbh-toast.is-out { opacity: 0; transform: translateY(-8px); transition: opacity .2s ease, transform .2s ease; }

@keyframes fbh-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes fbh-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
@keyframes fbh-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .fbh-panel, .fbh-chevron, .fbh-fab, .fbh-switch i, .fbh-switch i::after { transition: none; }
  .fbh-sk-avatar, .fbh-sk-line { animation: none; }
}
@media (max-width: 640px) {
  .fbh-head-actions .fbh-chip { display: none; }
  .fbh-dock { right: 12px; bottom: 76px; }
  .fbh-dock-panel { width: min(306px, calc(100vw - 24px)); }
}
`;

    function injectStyles() {
        if ($('#fbh-style')) return;
        const style = h('style', { id: 'fbh-style', text: STYLE });
        (document.head || document.documentElement).appendChild(style);
    }

    function toast(message, duration) {
        let host = $('#fbh-toast-host');
        if (!host) host = h('div', { id: 'fbh-toast-host', class: 'fbh-toast-host' });
        if (!host.isConnected) document.body.appendChild(host);
        const el = h('div', { class: 'fbh-toast', text: message });
        host.appendChild(el);
        setTimeout(() => {
            el.classList.add('is-out');
            setTimeout(() => el.remove(), 220);
        }, duration || 2600);
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* 退回 execCommand */ }
        try {
            const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }

    /* ---------- HTTP：GM_xmlhttpRequest 优先，fetch 兜底 ---------- */

    let cookiePromise = null;
    function getCookieHeader() {
        if (cookiePromise) return cookiePromise;
        cookiePromise = new Promise((resolve) => {
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; resolve(val || ''); } };
            const fallback = () => { try { done(document.cookie || ''); } catch (e) { done(''); } };
            try {
                if (typeof GM_cookie === 'object' && GM_cookie && typeof GM_cookie.list === 'function') {
                    GM_cookie.list({ domain: 'ke.fenbi.com' }, (a, b) => {
                        const list = Array.isArray(a) ? a : (Array.isArray(b) ? b : []);
                        if (list.length) done(list.map((c) => `${c.name}=${c.value}`).join('; '));
                        else fallback();
                    });
                    setTimeout(fallback, 1200);
                    return;
                }
            } catch (e) { /* 忽略 */ }
            fallback();
        });
        return cookiePromise;
    }

    function fetchText(url) {
        return fetch(url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } })
            .then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            });
    }

    function gmRequest(url, headers) {
        return new Promise((resolve, reject) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET', url, headers, timeout: 15000,
                    onload: (res) => (res.status >= 200 && res.status < 300)
                        ? resolve(String(res.responseText || ''))
                        : reject(new Error('HTTP ' + res.status)),
                    onerror: () => reject(new Error('网络请求失败')),
                    ontimeout: () => reject(new Error('请求超时'))
                });
            } catch (e) { reject(e); }
        });
    }

    async function httpGet(url) {
        // 实测粉笔允许跨域 GET 且自动携带登录态：页面 fetch 最稳，也不依赖 @connect 授权
        try {
            return await fetchText(url);
        } catch (fetchErr) {
            if (typeof GM_xmlhttpRequest === 'function') {
                const clean = { Accept: 'application/json, text/plain, */*' };
                try { return await gmRequest(url, clean); } catch (e) { /* 继续降级 */ }
                try {
                    const cookie = await getCookieHeader();
                    if (cookie) return await gmRequest(url, Object.assign({}, clean, { Cookie: cookie }));
                } catch (e) { /* 忽略 */ }
            }
            throw fetchErr;
        }
    }

    async function getJson(url) {
        const text = (await httpGet(url)).trim();
        if (!text) throw new Error('响应为空');
        if (text.charAt(0) === '<') throw new Error('返回了 HTML，可能是未登录或接口已变更');
        try { return JSON.parse(text); } catch (e) { throw new Error('响应不是合法 JSON'); }
    }

    /* ==============================================================
     * 3. 数据服务：旁路捕获 → 兜底请求 → 映射与缓存
     * ============================================================== */

    function pickEpisodeId(bucket, depth) {
        const d = depth || 0;
        if (!bucket || d > 5) return '';
        if (Array.isArray(bucket)) {
            for (const item of bucket) {
                const found = pickEpisodeId(item, d + 1);
                if (found) return found;
            }
            return '';
        }
        if (!isObj(bucket)) return '';
        const stat = isObj(bucket.episodeStat) ? bucket.episodeStat : {};
        const direct = firstString(
            String(stat.episodeId || ''), String(stat.episode_id || ''),
            String(bucket.episodeId || ''), String(bucket.episode_id || ''),
            String(bucket.id || '')
        );
        if (/^\d{2,13}$/.test(direct)) return direct;
        // 实测 data[tikuId] = { "0": { id: episodeId, ... } }，数字键必须遍历；
        // 但跳过 teacher / memberInfo 等对象，避免把老师 ID 误当成 episodeId
        const keys = Object.keys(bucket).filter((key) =>
            /^\d+$/.test(key) ||
            ['episodes', 'episode', 'episodeStat', 'datas', 'data', 'items', 'list'].indexOf(key) >= 0
        );
        for (const key of keys) {
            const found = pickEpisodeId(bucket[key], d + 1);
            if (found) return found;
        }
        return '';
    }

    function looksLikeQuestion(value) {
        return !!(value && (value.content || value.stem || value.options ||
            value.choices || value.correctAnswer || value.questionType));
    }

    function parseIdList(raw) {
        return String(raw || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4,13}$/.test(s));
    }

    /** 错题本等页面没有 questionKey，尝试从 Angular 组件上下文里取题目 ID */
    function idsFromAngularContext(host) {
        const out = [];
        const seen = new Set();
        let visited = 0;
        const walk = (value, depth) => {
            if (!value || typeof value !== 'object' || depth > 6 || visited++ > 900) return;
            if (seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) {
                const cap = Math.min(value.length, 200);
                for (let i = 0; i < cap; i++) walk(value[i], depth + 1);
                return;
            }
            if (value.nodeType) return;
            try {
                const key = firstString(value.key, value.globalId, value.questionKey);
                const rawId = value.id != null ? value.id
                    : (value.questionId != null ? value.questionId
                        : (value.tikuId != null ? value.tikuId : value.tiku_id));
                const id = numericId(rawId);
                const questionLike = looksLikeQuestion(value);
                if (id && (KEY_RE.test(key) || questionLike)) {
                    if (out.indexOf(id) === -1) out.push(id);
                }
                Object.keys(value).forEach((k) => {
                    if (k === 'parent' || k === 'children' || k === '__ngContext__') return;
                    const child = value[k];
                    if (child && typeof child === 'object') walk(child, depth + 1);
                });
            } catch (e) { /* 某些 getter 会抛错，忽略该节点 */ }
        };
        try { walk(host && host.__ngContext__, 0); } catch (e) { /* 忽略 */ }
        return out.slice(0, 6);
    }

    function performanceApiUrls() {
        try {
            return performance.getEntriesByType('resource')
                .map((entry) => entry.name)
                .filter((url) => /fenbi\.com/i.test(url) &&
                    /(?:universal\/auth|question|solution|exercise|tiku|episode|error)/i.test(url));
        } catch (e) { return []; }
    }

    /** 从浏览器已记录的请求 URL 里直接提取题号，不依赖 XHR hook 是否命中 */
    function idsFromPerformance() {
        const ids = [];
        const add = (value) => {
            const id = numericId(value);
            if (id && ids.indexOf(id) === -1) ids.push(id);
        };
        performanceApiUrls().forEach((raw) => {
            try {
                const url = new URL(raw);
                ['questionIds', 'question_ids', 'tiku_ids', 'ids'].forEach((key) => {
                    parseIdList(url.searchParams.get(key)).forEach(add);
                });
                if (/(?:universal\/auth|questions|solutions|exercise|errorbook|error-book)/i.test(url.pathname)) {
                    add(url.searchParams.get('id'));
                }
            } catch (e) { /* 忽略非法 URL */ }
        });
        return ids;
    }

    function formatTime(value) {
        if (value === null || value === undefined || value === '') return '';
        let ts = Number(value);
        if (Number.isFinite(ts) && ts > 0) {
            if (ts < 1e11) ts *= 1000;
            const d = new Date(ts);
            if (!Number.isNaN(d.getTime())) {
                const p = (n) => String(n).padStart(2, '0');
                return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
            }
        }
        return String(value).slice(0, 16);
    }

    function safeAvatar(value) {
        if (typeof value !== 'string' || !value.trim()) return '';
        const raw = value.startsWith('//') ? 'https:' + value : value;
        try {
            const url = new URL(raw, location.origin);
            return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
        } catch (e) { return ''; }
    }

    function normalizeComment(e) {
        if (!isObj(e)) return null;
        const user = isObj(e.user) ? e.user : {};
        const userInfo = isObj(e.userInfo) ? e.userInfo : {};
        const like = Number(e.likeCount != null ? e.likeCount : e.like_count);
        const rating = Number(firstString(
            String(e.fiveGradeScore || ''), String(e.rate || ''), String(e.score || '')
        ));
        const text = firstString(e.comment, e.content, e.text);
        if (!text) return null;
        const tsRaw = firstString(String(e.createdTime || ''), String(e.createTime || ''),
            String(e.time || ''), String(e.createdAt || ''));
        return {
            id: e.id != null ? String(e.id) : '',
            name: firstString(e.nickName, e.nickname, e.userName, e.username, e.authorName,
                user.nickname, user.nickName, user.name, user.userName,
                userInfo.nickname, userInfo.name) || '粉笔用户',
            avatar: safeAvatar(firstString(e.avatar, e.avatarUrl, e.userAvatar, e.headImg,
                user.avatar, user.avatarUrl, userInfo.avatar)),
            region: firstString(e.ipLocation, e.ipLocationName, e.province, e.location,
                user.province, userInfo.province),
            time: formatTime(tsRaw),
            ts: Number(tsRaw) || 0,
            text,
            likes: Number.isFinite(like) ? Math.max(0, Math.trunc(like)) : 0,
            rating: Number.isFinite(rating) && rating > 0 ? Math.min(5, Math.round(rating > 5 ? rating / 2 : rating)) : 0
        };
    }

    class DataService {
        constructor() {
            this.keyToId = new Map();       // questionKey -> 数字题号
            this.episodes = new Map();      // 数字题号 -> episodeId
            this.orderIds = [];             // 页面题目顺序（数字题号）
            const routecs = new URLSearchParams(location.search).get('routecs') || 'xingce';
            this.prefix = routecs;
            // tiku_prefix 与 tiku_type 必须配对，且与 URL 上的 routecs 未必相同
            this.prefixCandidates = [routecs, 'sydw', 'gwy'];
            this.pageParams = {};           // 页面接口的公共参数（新版带 deviceId 校验）
            this.lastEpisodeError = '';
            this.angularCache = new WeakMap();
            this.cardCount = 0;
            this.commentCache = new Map();  // `${ep}|${start}|${len}` -> Promise
            this.prepared = null;
            this.captureCount = 0;
        }

        get exerciseKey() {
            const parts = location.pathname.split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
        }

        /** 在页面发请求之前挂上：只读旁路，不改变页面请求行为 */
        installCapture() {
            const XP = PAGE_WINDOW.XMLHttpRequest && PAGE_WINDOW.XMLHttpRequest.prototype;
            if (XP && !XP.__fbhHooked) {
                XP.__fbhHooked = true;
                const origOpen = XP.open;
                const origSend = XP.send;
                const self = this;
                XP.open = function (method, url) {
                    this.__fbhUrl = String(url || '');
                    return origOpen.apply(this, arguments);
                };
                XP.send = function (body) {
                    const xhr = this;
                    const url = xhr.__fbhUrl || '';
                    if (self.isDataUrl(url)) {
                        xhr.addEventListener('readystatechange', function () {
                            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                                try { self.capture(url, xhr.responseText, body); } catch (e) { warn('解析响应失败', e); }
                            }
                        });
                    }
                    return origSend.apply(this, arguments);
                };
            }

            const origFetch = PAGE_WINDOW.fetch;
            if (typeof origFetch === 'function' && !PAGE_WINDOW.__fbhFetchHooked) {
                PAGE_WINDOW.__fbhFetchHooked = true;
                const self = this;
                PAGE_WINDOW.fetch = function (input, init) {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    const promise = origFetch.apply(this, arguments);
                    if (self.isDataUrl(url) && promise && typeof promise.then === 'function') {
                        try {
                            promise.then((res) => {
                                res.clone().text().then((text) => {
                                    try { self.capture(url, text, init && init.body); } catch (e) { warn('解析响应失败', e); }
                                }).catch(() => {});
                            }).catch(() => {});
                        } catch (e) { /* 忽略 */ }
                    }
                    return promise;
                };
            }
        }

        isDataUrl(url) {
            const u = String(url || '');
            if (!u || /^(?:chrome-extension|data|blob):/i.test(u)) return false;
            if (/\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|ico|mp4|m3u8)(?:\?|$)/i.test(u)) return false;
            if (/(?:solution|exercise|getMeta|questionIds|tiku_episodes_with_multi_type|report_display_cards)/i.test(u)) return true;
            // 错题本接口路径可能变化：粉笔题库域名下的题库 API 也一并观察
            return /(?:tiku|www|spa)\.fenbi\.com/i.test(u) && /\/(?:tiku|tikuApi|combine|ke|api)\//i.test(u);
        }

        addPrefix(prefix) {
            const p = String(prefix || '').trim();
            if (!p || !/^[a-z][a-z0-9_]{1,24}$/i.test(p)) return;
            this.prefixCandidates = [p].concat(this.prefixCandidates.filter((v) => v !== p)).slice(0, 5);
            this.prefix = p;
        }

        capture(url, text, body) {
            this.captureCount++;
            const qs = new URLSearchParams((url.split('?')[1] || ''));
            const urlPrefix = qs.get('tiku_prefix') || qs.get('routecs');
            if (urlPrefix) this.addPrefix(urlPrefix);

            // 错题本 / 背题页：题目接口 URL 直接带当前页 questionIds，顺序即页面题卡顺序
            const qidParam = qs.get('questionIds') || qs.get('question_ids');
            if (qidParam) {
                const ids = parseIdList(qidParam);
                if (ids.length) this.setOrderIds(ids, 'questionIds');
            }
            if (/user-answers/i.test(url)) {
                const answerIds = parseIdList(qs.get('ids'));
                if (answerIds.length) this.setOrderIds(answerIds, 'userAnswers');
            }

            // 新版练习接口带 deviceId / 版本号校验，兜底请求复用同一组参数
            if (/combine\/exercise\/(?:getSolution|getReport)/.test(url)) {
                ['deviceId', 'kav', 'av', 'hav', 'gav', 'apcid', 'app'].forEach((key) => {
                    const value = qs.get(key);
                    if (value) this.pageParams[key] = value;
                });
            }

            if (/report_display_cards/.test(url) && body) {
                const payload = String(body);
                const fromArray = payload.match(/"questionIds"\s*:\s*\[([^\]]+)\]/);
                const ids = fromArray
                    ? fromArray[1].split(',').map((s) => s.replace(/["\s]/g, '')).filter((s) => /^\d{4,13}$/.test(s))
                    : Array.from(payload.matchAll(/"questionId"\s*:\s*(\d{5,13})/g)).map((m) => m[1]);
                if (ids.length) this.setOrderIds(ids, 'body');
            }
            if (/tiku_episodes_with_multi_type/.test(url)) {
                const ids = parseIdList(qs.get('tiku_ids'));
                if (ids.length) this.setOrderIds(ids, 'url');
            }
            const payload = String(text || '').trim();
            if (payload.charAt(0) !== '{' && payload.charAt(0) !== '[') return;
            let json;
            try { json = JSON.parse(payload); } catch (e) { return; }

            if (/tiku_episodes_with_multi_type/.test(url)) {
                this.ingestEpisodes(isObj(json.data) ? json.data : json);
            } else {
                this.ingestSolution(json);
            }
        }

        setOrderIds(ids, source) {
            const clean = ids.map(String).filter((v) => /^\d{4,13}$/.test(v));
            if (!clean.length) return;
            // 顺序来源可信度：题目接口 questionIds > 作答列表 > tiku_ids > 答题卡请求体
            const rank = { questionIds: 6, solutionsResponse: 5, performance: 3, userAnswers: 3, url: 2, body: 1 };
            // 题号不足一整页时，允许低优先级来源（如 performance 汇总）补齐
            const incomplete = this.cardCount && this.orderIds.length < this.cardCount;
            if ((rank[source] || 0) < (rank[this.orderSource] || 0) && !incomplete) return;
            // notes / errors 等单题请求也会带 questionIds，不能用它覆盖整页顺序
            if (this.orderIds.length > clean.length &&
                clean.some((id) => this.orderIds.indexOf(id) >= 0)) return;
            this.orderIds = clean;
            this.orderSource = source;
            log('题号顺序', source, clean.length, clean.slice(0, 3).join(','));
        }

        /** 递归扫描题目/解析 JSON，建立 questionKey → tikuId 映射 */
        ingestSolution(root) {
            let visited = 0;
            const ordered = [];
            const add = (key, id) => {
                const k = firstString(key);
                const v = numericId(id);
                if (!v || !KEY_RE.test(k)) return;
                this.keyToId.set(k, v);
                // 同时按响应中的对象顺序记录题号：错题本题卡没有 key，只能靠顺序对齐
                if (ordered.indexOf(v) === -1) ordered.push(v);
            };
            const walk = (node, depth, parentKey) => {
                if (visited++ > 6000 || depth > 7 || !isObj(node)) return;
                if (Array.isArray(node)) {
                    node.forEach((item) => walk(item, depth + 1, parentKey));
                    return;
                }
                ['tikuPrefix', 'kePrefix', 'prefix'].forEach((key) => {
                    if (typeof node[key] === 'string') this.addPrefix(node[key]);
                });
                const ids = [node.id, node.questionId, node.tikuId, node.tiku_id, node.solutionId];
                const id = ids.map(numericId).find(Boolean);
                const keys = [parentKey, node.key, node.globalId, node.questionKey, node.qKey];
                if (id) keys.forEach((k) => add(k, id));
                // 错题本的题目对象可能不带 key，用题干/选项字段识别后按响应顺序记录
                if (id && ordered.indexOf(id) === -1 && looksLikeQuestion(node)) ordered.push(id);
                for (const [k, v] of Object.entries(node)) {
                    if (isObj(v)) walk(v, depth + 1, k);
                }
            };
            walk(root, 0, '');
            if (ordered.length) this.setOrderIds(ordered, 'solutionsResponse');
            log('题目映射', this.keyToId.size, '条 / 题号', this.orderIds.length, '个');
        }

        ingestEpisodes(data) {
            if (!isObj(data)) return;
            Object.entries(data).forEach(([tikuId, bucket]) => {
                const ep = pickEpisodeId(bucket);
                if (ep && /^\d{4,13}$/.test(String(tikuId))) this.episodes.set(String(tikuId), ep);
            });
            log('小节映射', this.episodes.size, '条');
        }

        /** 兜底：页面请求未捕获时，主动读取当前练习的题目数据 */
        prepare() {
            if (this.prepared) return this.prepared;
            this.prepared = (async () => {
                const key = this.exerciseKey;
                if (!key || !KEY_RE.test(key)) return;
                const qs = new URLSearchParams({
                    format: 'html', key, routecs: this.prefix,
                    kav: '121', av: '121', hav: '121', app: 'web'
                });
                Object.entries(this.pageParams).forEach(([k, v]) => qs.set(k, v));
                const url = 'https://tiku.fenbi.com/combine/exercise/getSolution?' + qs.toString();
                try {
                    this.ingestSolution(await getJson(url));
                } catch (e) {
                    this.prepared = null;   // 失败不永久缓存，允许「重新加载」重试
                    log('题目映射兜底请求失败（仍可用页面请求与题目 key）', e.message);
                }
            })();
            return this.prepared;
        }

        /** 题目 key 末段是数字题号的 base36 编码，例如 3_1_4efej → 7391611 */
        keyToNumericId(questionKey) {
            const seg = String(questionKey || '').split('_').pop();
            if (!/^[0-9a-z]{3,12}$/i.test(seg)) return '';
            const num = parseInt(seg, 36);
            return Number.isFinite(num) && num > 100000 && num < 1e12 ? String(num) : '';
        }

        currentPageOffset() {
            if (!this.cardCount) return 0;
            const parts = location.pathname.split('/').filter(Boolean);
            const page = Number(parts[parts.length - 1]);
            if (!Number.isInteger(page) || page < 1) return 0;
            // 只有拿到整本错题的全量题号时才按页码偏移；当前页请求的题号直接用
            const total = Number(new URLSearchParams(location.search).get('total'));
            if (!Number.isFinite(total) || total <= this.cardCount) return 0;
            if (this.orderIds.length < total) return 0;
            return (page - 1) * Math.max(this.cardCount, 10);
        }

        syncPerformanceIds() {
            // 题号不足一整页时，即使来源是 questionIds（可能是单题 notes）也尝试用 performance 补齐
            const strong = ['questionIds', 'solutionsResponse', 'performance', 'userAnswers'];
            const complete = this.cardCount ? this.orderIds.length >= this.cardCount : this.orderIds.length > 0;
            if (complete && strong.indexOf(this.orderSource) >= 0) return;
            const ids = idsFromPerformance();
            if (ids.length) this.setOrderIds(ids, 'performance');
        }

        candidateIds(questionKey, index, host) {
            this.syncPerformanceIds();
            const ids = [];
            const add = (value) => {
                const id = numericId(value);
                if (id && ids.indexOf(id) === -1) ids.push(id);
            };
            add(this.keyToId.get(questionKey));
            if (Number.isInteger(index)) add(this.orderIds[this.currentPageOffset() + index]);
            if (host) {
                let extracted = this.angularCache.get(host);
                if (!extracted) {
                    extracted = idsFromAngularContext(host);
                    if (extracted.length) this.angularCache.set(host, extracted);
                }
                extracted.forEach(add);
            }
            add(this.keyToNumericId(questionKey));
            return ids;
        }

        prewarmIds() {
            const ids = [];
            const add = (id) => { if (id && ids.indexOf(id) === -1) ids.push(id); };
            $$('app-ti[data-question-key]').forEach((el, index) => {
                this.candidateIds(el.dataset.questionKey, index, el).forEach(add);
            });
            if (!ids.length) {
                // 错题本 / 背题页题卡没有 questionKey，按接口顺序 + Angular 上下文兜底
                $$('fb-local-question, fb-recitatation-question').forEach((el, index) => {
                    this.candidateIds('__idx_' + index, index, el).forEach(add);
                });
            }
            return ids.slice(0, 60);
        }

        /** 错题页题号通常晚于 DOM 到达，点击时短暂等待一次 */
        async waitForOrderIds(index, timeout) {
            const deadline = Date.now() + (timeout || 2500);
            const pick = () => this.orderIds[this.currentPageOffset() + index] || '';
            while (!pick() && Date.now() < deadline) {
                this.syncPerformanceIds();
                if (pick()) break;
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            return pick();
        }

        episodePairs() {
            const pairs = [];
            const seen = new Set();
            const push = (prefix, type) => {
                const key = prefix + '/' + type;
                if (seen.has(key)) return;
                seen.add(key);
                pairs.push([prefix, type]);
            };
            // 实测有效配对优先：URL 上的 routecs 未必等于题库 tiku_prefix
            [['sydw', 5], ['gwy', 1], ['xingce', 5], ['sydw', 1]].forEach(([p, t]) => push(p, t));
            this.prefixCandidates.slice(0, 4).forEach((p) => [5, 1, 3, 2, 4].forEach((t) => push(p, t)));
            return pairs.slice(0, 16);
        }

        async ensureEpisodes(ids) {
            const wanted = ids.map(numericId).filter(Boolean);
            if (!wanted.length) return;
            if (this.episodeBatch) {
                await this.episodeBatch;
                if (!wanted.some((id) => !this.episodes.has(id))) return;
            }
            const job = (async () => {
                let lastError = '';
                let attempts = 0;
                for (const [prefix, type] of this.episodePairs()) {
                    const missing = wanted.filter((id) => !this.episodes.has(id));
                    if (!missing.length) { this.lastEpisodeError = ''; return; }
                    if (attempts >= 8) break;
                    attempts++;
                    const url = 'https://ke.fenbi.com/api/gwy/v3/episodes/tiku_episodes_with_multi_type?tiku_ids=' +
                        missing.join(',') + '&tiku_prefix=' + encodeURIComponent(prefix) + '&tiku_type=' + type;
                    try {
                        const json = await getJson(url);
                        if (json && json.code === -1) {
                            lastError = `题库参数不匹配（${prefix}/${type}）`;
                            continue;
                        }
                        const before = this.episodes.size;
                        this.ingestEpisodes(isObj(json.data) ? json.data : json);
                        if (this.episodes.size > before) {
                            lastError = '';
                            log('小节映射命中', `${prefix}/${type}`, `新增 ${this.episodes.size - before}`);
                        }
                    } catch (e) {
                        lastError = e.message;
                        log('小节映射请求失败', `${prefix}/${type}`, e.message);
                    }
                }
                this.lastEpisodeError = lastError;
            })();
            this.episodeBatch = job;
            try { await job; } finally { this.episodeBatch = null; }
        }

        fetchComments(episodeId, start, len) {
            const cacheKey = `${episodeId}|${start}|${len}`;
            if (!this.commentCache.has(cacheKey)) {
                const urls = [
                    `https://ke.fenbi.com/ipad/gwy/v3/comments/episodes/${episodeId}?${COMMENT_QS}&len=${len}&start=${start}`,
                    `https://ke.fenbi.com/android/${encodeURIComponent(this.prefix)}/v3/comments/episodes/${episodeId}?start=${start}&len=${len}`,
                    `https://ke.fenbi.com/android/gwy/v3/comments/episodes/${episodeId}?start=${start}&len=${len}`
                ].filter((url, index, list) => list.indexOf(url) === index);
                const job = (async () => {
                    let lastError = null;
                    for (const url of urls) {
                        try {
                            const json = await getJson(url);
                            const raw = Array.isArray(json.datas) ? json.datas : (Array.isArray(json.data) ? json.data : null);
                            if (!raw) throw new Error('评论接口返回结构异常');
                            // 实测字段为 total，部分版本为 totalCount
                            const total = Number(json.total != null ? json.total : json.totalCount);
                            return {
                                items: raw.map(normalizeComment).filter(Boolean),
                                total: Number.isFinite(total) ? total : null
                            };
                        } catch (e) { lastError = e; }
                    }
                    throw lastError || new Error('评论接口不可用');
                })();
                this.commentCache.set(cacheKey, job);
                job.catch(() => this.commentCache.delete(cacheKey));
            }
            return this.commentCache.get(cacheKey);
        }

        clearComments(episodeId) {
            if (!episodeId) return;
            Array.from(this.commentCache.keys())
                .filter((key) => key.startsWith(episodeId + '|'))
                .forEach((key) => this.commentCache.delete(key));
        }
    }

    const data = new DataService();

    /* ==============================================================
     * 4. 功能模块 A：自动展开解析（合并原 v3.0 逻辑）
     * ============================================================== */

    function expandPanels() {
        let fixed = 0;
        $$('.result-common-container-toggle').forEach((container) => {
            const style = container.getAttribute('style') || '';
            if (/height:\s*0px/i.test(style) || /overflow:\s*hidden/i.test(style)) {
                container.style.removeProperty('height');
                container.style.removeProperty('overflow');
                fixed++;
            }
        });
        if (fixed) log('修复折叠解析面板', fixed, '个');
    }

    /* ==============================================================
     * 5. 功能模块 B：题目讨论
     * ============================================================== */

    const views = new Map();          // questionKey -> view
    const loadQueue = [];
    let runningLoads = 0;

    function enqueueLoad(view, options) {
        loadQueue.push({ view, options });
        pumpLoads();
    }

    function pumpLoads() {
        while (runningLoads < 3 && loadQueue.length) {
            const task = loadQueue.shift();
            if (!task.view.section.isConnected) continue;
            runningLoads++;
            loadComments(task.view, task.options || {})
                .catch((e) => warn('评论加载异常', e))
                .finally(() => { runningLoads--; pumpLoads(); });
        }
    }

    function questionKeyOf(host, index) {
        const appTi = host.closest('app-ti');
        if (appTi && appTi.dataset.questionKey) return appTi.dataset.questionKey;
        const section = host.querySelector('section[id^="section-solution-"]');
        if (section) return section.id.slice('section-solution-'.length);
        const inner = host.closest('.ti') && host.closest('.ti').querySelector('app-ti[data-question-key]');
        if (inner) return inner.dataset.questionKey;
        return `__idx_${index}`;
    }

    function createView(host, key, index) {
        const head = h('div', {
            class: 'fbh-head', role: 'button', tabindex: '0', 'aria-expanded': 'false',
            title: '展开本题讨论'
        }, [
            h('span', { class: 'fbh-head-main' }, [
                h('span', { html: ICONS.bubble }),
                h('span', { class: 'fbh-title', text: '题目讨论' }),
                h('span', { class: 'fbh-qnum', hidden: true }),
                h('span', { class: 'fbh-badge', hidden: true })
            ]),
            h('span', { class: 'fbh-head-actions' }, [
                h('button', { class: 'fbh-chip' + (settings.sort === 'hot' ? ' is-active' : ''), dataset: { sort: 'hot' }, type: 'button', text: '最热' }),
                h('button', { class: 'fbh-chip' + (settings.sort === 'new' ? ' is-active' : ''), dataset: { sort: 'new' }, type: 'button', text: '最新' }),
                h('button', { class: 'fbh-icon-btn', dataset: { action: 'refresh' }, type: 'button', title: '重新加载评论', html: ICONS.refresh }),
                h('span', { class: 'fbh-chevron', html: ICONS.chevron })
            ])
        ]);

        const stateBox = h('div', { class: 'fbh-state' });
        const list = h('div', { class: 'fbh-list' });
        const more = h('button', { class: 'fbh-more', type: 'button', text: '加载更多评论', hidden: true });
        const body = h('div', { class: 'fbh-body' }, [
            stateBox, list, more,
            h('div', { class: 'fbh-foot', text: '评论来自粉笔解析课讨论区 · 粉笔助手呈现' })
        ]);
        const section = h('section', {
            class: 'fbh-section', id: `section-comments-${key}`, dataset: { fbhKey: key }
        }, [
            head,
            h('div', { class: 'fbh-panel' }, [h('div', { class: 'fbh-panel-inner' }, [body])])
        ]);

        const view = {
            key, index, host, section, head, stateBox, list, more,
            badge: $('.fbh-badge', head),
            qnum: $('.fbh-qnum', head),
            refreshBtn: $('[data-action="refresh"]', head),
            quickBtn: null,
            mount: host, titleBar: null, standalone: false,
            open: false, loading: false, loaded: false,
            items: [], start: 0, lastCount: 0, total: null, episodeId: ''
        };

        head.addEventListener('click', (event) => {
            const target = event.target;
            const closest = (sel) => (target && target.closest ? target.closest(sel) : null);
            const chip = closest('[data-sort]');
            if (chip) {
                event.stopPropagation();
                if (settings.sort !== chip.dataset.sort) {
                    settings.sort = chip.dataset.sort;
                    saveSettings();
                    bus.emit('settings', 'sort');
                }
                return;
            }
            if (closest('[data-action="refresh"]')) {
                event.stopPropagation();
                if (view.loading) return;
                data.clearComments(view.episodeId);
                enqueueLoad(view, { refresh: true });
                return;
            }
            toggleView(view);
        });
        head.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleView(view);
            }
        });
        more.addEventListener('click', () => {
            if (!view.loading) enqueueLoad(view, { append: true });
        });
        return view;
    }

    function attachView(view) {
        const mount = view.mount || view.host;
        if (view.section.parentElement !== mount) mount.appendChild(view.section);
        view.section.classList.toggle('fbh-section--standalone', !!view.standalone);

        if (!settings.quickEntry || !view.titleBar) {
            if (view.quickBtn) view.quickBtn.remove();
            return;
        }
        if (!view.quickBtn) {
            view.quickBtn = h('li', {
                class: 'fbh-quick', title: '查看本题讨论', role: 'button', tabindex: '0', html: ICONS.bubble,
                onclick: () => {
                    toggleView(view, true);
                    view.section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                },
                onkeydown: (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); view.quickBtn.click(); }
                }
            });
        }
        if (view.quickBtn.parentElement !== view.titleBar) view.titleBar.appendChild(view.quickBtn);
        view.quickBtn.classList.toggle('is-open', view.open);
    }

    function questionLabel(host, appTi) {
        const node = (appTi && $('.title-index', appTi)) || $('.options-title', host) || $('.title-index', host);
        const text = node && node.textContent ? node.textContent.trim() : '';
        return text.replace(/[.．、\s]+$/, '');
    }

    /** 解析页题卡是 app-result-common；错题本 / 背题页是 fb-local-question 等 */
    function collectHosts() {
        const entries = [];
        $$('app-result-common').forEach((host, index) => {
            const mount = $('.result-common-container', host);
            if (!mount) return;
            const appTi = host.closest('app-ti');
            entries.push({
                host, index, mount,
                titleBar: appTi ? $('.title-right', appTi) : null,
                label: questionLabel(host, appTi),
                standalone: false
            });
        });
        if (entries.length) return entries;

        $$('fb-local-question, fb-recitatation-question').forEach((host, index) => {
            entries.push({
                host, index, mount: host, titleBar: null,
                label: questionLabel(host, null),
                standalone: true
            });
        });
        return entries;
    }

    function destroyView(view) {
        view.section.remove();
        if (view.quickBtn) view.quickBtn.remove();
    }

    function mountComments() {
        const entries = collectHosts();
        data.cardCount = entries.length;
        const hosts = entries.map((entry) => entry.host);
        for (const [key, view] of views) {
            if (!view.host.isConnected || hosts.indexOf(view.host) === -1) {
                destroyView(view);
                views.delete(key);
            }
        }
        entries.forEach((entry) => {
            const host = entry.host;
            const index = entry.index;
            const key = questionKeyOf(host, index);
            let view = views.get(key);
            if (!view || view.host !== host) {
                if (view) destroyView(view);
                view = createView(host, key, index);
                views.set(key, view);
            }
            view.index = index;
            view.mount = entry.mount;
            view.titleBar = entry.titleBar;
            view.standalone = entry.standalone;
            const label = entry.label || '';
            if (view.qnum) {
                view.qnum.textContent = label ? `第 ${label} 题` : '';
                view.qnum.hidden = !label;
            }
            attachView(view);
        });
    }

    function unmountComments() {
        views.forEach(destroyView);
        views.clear();
    }

    function toggleView(view, force) {
        const open = typeof force === 'boolean' ? force : !view.open;
        view.open = open;
        view.section.classList.toggle('is-open', open);
        view.head.setAttribute('aria-expanded', String(open));
        view.head.title = open ? '收起本题讨论' : '展开本题讨论';
        if (view.quickBtn) view.quickBtn.classList.toggle('is-open', open);
        // 即便用户关闭了「自动展开解析」，点开讨论时也要保证所在面板可见
        if (open) {
            const container = $('.result-common-container', view.host);
            if (container) {
                container.style.removeProperty('height');
                container.style.removeProperty('overflow');
            }
        }
        if (open && !view.loaded && !view.loading) enqueueLoad(view, {});
        bus.emit('status');
    }

    function syncSortChips() {
        views.forEach((view) => {
            $$('[data-sort]', view.head).forEach((chip) => chip.classList.toggle('is-active', chip.dataset.sort === settings.sort));
            if (view.loaded) renderList(view);
        });
    }

    function qualityFilter(item) {
        return settings.qualityOnly && !(item.likes > 1 && item.text.length > 8 && !/[?？]/.test(item.text));
    }

    function sortedItems(view) {
        const items = view.items.filter((item) => !qualityFilter(item));
        if (settings.sort === 'new') {
            return items.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
        }
        return items.slice().sort((a, b) => b.likes - a.likes);
    }

    function mergeItems(existing, incoming) {
        const seen = new Set(existing.map((item) => item.id || item.text));
        incoming.forEach((item) => {
            const id = item.id || item.text;
            if (!seen.has(id)) { existing.push(item); seen.add(id); }
        });
        return existing;
    }

    async function loadComments(view, options) {
        if (view.loading) return;
        view.loading = true;
        view.refreshBtn.classList.add('is-spinning');
        renderLoading(view, options.append);

        try {
            let ids = data.candidateIds(view.key, view.index, view.host);
            if (!ids.length) {
                await data.prepare();
                ids = data.candidateIds(view.key, view.index, view.host);
            }
            if (!ids.length) {
                const lateId = await data.waitForOrderIds(view.index);
                if (lateId) ids = [lateId];
            }
            if (!ids.length) throw new Error('未定位到本题题号，请确认已登录且页面加载完成后重试');

            await data.ensureEpisodes(ids);
            const episodeId = ids.map((id) => data.episodes.get(String(id))).find(Boolean) || '';
            if (!episodeId) {
                // 接口正常但本题没有解析课：这是「暂无讨论」，不是加载失败
                if (data.lastEpisodeError) throw new Error(`讨论小节映射失败：${data.lastEpisodeError}`);
                renderNoEpisode(view);
                view.loaded = true;
                return;
            }
            view.episodeId = episodeId;

            const start = options.refresh ? 0 : view.start;
            const result = await data.fetchComments(episodeId, start, settings.pageSize);
            if (options.refresh) {
                view.items = [];
                view.start = 0;
            }
            mergeItems(view.items, result.items);
            view.start += result.items.length;
            view.lastCount = result.items.length;
            view.total = result.total;
            view.loaded = true;
            renderList(view);
        } catch (error) {
            renderError(view, error);
        } finally {
            view.loading = false;
            view.refreshBtn.classList.remove('is-spinning');
            bus.emit('status');
        }
    }

    function renderLoading(view, isAppend) {
        view.stateBox.textContent = '';
        view.stateBox.hidden = false;
        if (isAppend) {
            view.more.textContent = '加载中…';
            return;
        }
        view.list.textContent = '';
        view.more.hidden = true;
        const skeleton = h('div', { class: 'fbh-skeleton' });
        for (let i = 0; i < 3; i++) {
            skeleton.appendChild(h('div', { class: 'fbh-skeleton-row' }, [
                h('div', { class: 'fbh-sk-avatar' }),
                h('div', { class: 'fbh-sk-lines' }, [
                    h('div', { class: 'fbh-sk-line short' }, []),
                    h('div', { class: 'fbh-sk-line' }, []),
                    h('div', { class: 'fbh-sk-line short' }, [])
                ])
            ]));
        }
        view.stateBox.appendChild(skeleton);
        view.stateBox.appendChild(h('div', { text: '正在加载大家的讨论…' }));
    }

    function renderNoEpisode(view) {
        view.list.textContent = '';
        view.more.hidden = true;
        view.stateBox.textContent = '';
        view.stateBox.hidden = false;
        view.badge.hidden = true;
        view.stateBox.appendChild(h('div', { class: 'fbh-state-title', text: '这道题还没有公开讨论' }));
        view.stateBox.appendChild(h('div', {
            text: '粉笔的讨论挂在解析课上，部分题目暂未开放评论；可点「重新加载」重试，或在助手面板一键展开其他题目的讨论。'
        }));
        view.stateBox.appendChild(h('button', {
            class: 'fbh-retry', type: 'button', text: '重新加载',
            onclick: () => { view.loaded = false; enqueueLoad(view, { refresh: true }); }
        }));
    }

    function renderError(view, error) {
        view.list.textContent = '';
        view.more.hidden = true;
        view.stateBox.textContent = '';
        view.stateBox.hidden = false;
        const message = error && error.message ? error.message : String(error);
        view.stateBox.appendChild(h('div', { class: 'fbh-state-title', text: '评论暂时没能加载' }));
        view.stateBox.appendChild(h('div', { text: message }));
        if (/未定位|HTML|HTTP 401|HTTP 403/.test(message)) {
            view.stateBox.appendChild(h('div', { text: '提示：需要保持粉笔账号登录，刷新页面后通常即可恢复' }));
        }
        if (/未定位/.test(message)) {
            const apis = performanceApiUrls().slice(-5).map((raw) => {
                try {
                    const url = new URL(raw);
                    return (url.pathname + url.search).slice(0, 120);
                } catch (e) { return ''; }
            }).filter(Boolean);
            if (apis.length) {
                view.stateBox.appendChild(h('div', { class: 'fbh-diag', text: '最近接口：' + apis.join('  |  ') }));
            }
            view.stateBox.appendChild(h('div', {
                class: 'fbh-diag',
                text: `映射：orderIds ${data.orderIds.length} · key ${data.keyToId.size}`
            }));
        }
        view.stateBox.appendChild(h('button', {
            class: 'fbh-retry', type: 'button', text: '重新加载',
            onclick: () => { data.clearComments(view.episodeId); enqueueLoad(view, { refresh: true }); }
        }));
    }

    function renderList(view) {
        view.stateBox.textContent = '';
        view.stateBox.hidden = true;
        view.list.textContent = '';
        const items = sortedItems(view);
        view.badge.hidden = false;
        view.badge.textContent = String(view.total || view.items.length);

        if (!items.length) {
            view.stateBox.hidden = false;
            view.stateBox.appendChild(h('div', {
                text: view.items.length && settings.qualityOnly
                    ? '没有符合「优质评论」条件的留言，可在助手面板关闭筛选'
                    : '这道题还没有讨论，来做第一个发言的人吧'
            }));
            view.more.hidden = true;
            return;
        }

        items.forEach((item) => view.list.appendChild(renderComment(item)));

        const hasMore = view.total !== null
            ? view.start < view.total
            : view.lastCount >= settings.pageSize;
        view.more.hidden = !hasMore;
        view.more.textContent = '加载更多评论';
    }

    function renderComment(item) {
        const avatar = h('span', { class: 'fbh-avatar', text: item.name.slice(0, 1) });
        if (item.avatar) {
            const img = h('img', { src: item.avatar, alt: '', loading: 'lazy' });
            img.addEventListener('error', () => img.remove());
            avatar.appendChild(img);
        }

        const meta = h('div', { class: 'fbh-meta' }, [
            h('span', { class: 'fbh-name', text: item.name })
        ]);
        if (item.region) meta.appendChild(h('span', { text: item.region }));
        if (item.time) meta.appendChild(h('span', { text: item.time }));
        if (item.rating) meta.appendChild(h('span', { class: 'fbh-stars', text: '★'.repeat(item.rating) + '☆'.repeat(5 - item.rating) }));

        const foot = h('div', { class: 'fbh-item-foot' }, [
            h('span', { class: 'fbh-like', html: ICONS.like }, [document.createTextNode(String(item.likes))])
        ]);
        if (item.likes >= 20) foot.appendChild(h('span', { class: 'fbh-hot', text: '高赞' }));
        foot.appendChild(h('button', {
            class: 'fbh-copy', type: 'button', text: '复制', title: '复制这条评论',
            onclick: async (event) => {
                const btn = event.currentTarget;
                const ok = await copyText(item.text);
                toast(ok ? '已复制这条评论' : '复制失败，请手动选中文本');
                if (ok) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1400); }
            }
        }));

        return h('div', { class: 'fbh-item' }, [
            avatar,
            h('div', { class: 'fbh-item-main' }, [
                meta,
                h('div', { class: 'fbh-text', text: item.text }),
                foot
            ])
        ]);
    }

    function expandAllComments(open) {
        const list = Array.from(views.values());
        if (!list.length) { toast('当前页面还没有找到解析面板'); return; }
        list.forEach((view) => toggleView(view, open));
        toast(open ? `已展开 ${list.length} 道题的讨论` : '已收起全部讨论');
    }

    /* ==============================================================
     * 6. 功能注册表
     * ============================================================== */

    const FEATURES = [
        {
            apply(ctx) { document.documentElement.classList.toggle('fbh-autoexpand', ctx.settings.autoExpand); },
            onDom(ctx) { if (ctx.settings.autoExpand) expandPanels(); }
        },
        {
            apply(ctx) {
                if (ctx.settings.comments) mountComments();
                else unmountComments();
            },
            onDom(ctx) { if (ctx.settings.comments) mountComments(); }
        },
        {
            apply(ctx) { document.documentElement.classList.toggle('fbh-focus', ctx.settings.focusMode); }
        },
        {
            apply(ctx) { if (ctx.settings.comments) mountComments(); }
        }
    ];

    const ctx = { settings };

    function applyAll() { FEATURES.forEach((feature) => feature.apply(ctx)); }
    function onDom() {
        FEATURES.forEach((feature) => { if (feature.onDom) feature.onDom(ctx); });
        placeDock();
        bus.emit('status');
    }

    /* ==============================================================
     * 7. 悬浮控制面板
     * ============================================================== */

    let dock = null;
    const DOCK_DEFAULT_BOTTOM = 96;

    /** 右下角悬浮按钮避开页面自带的「回到顶部 / 收起」按钮 */
    function placeDock() {
        if (!dock) return;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        let topEdge = Infinity;
        $$('.toTopActions, .ant-back-top-inner, [class*="toTop"], [class*="back-top"], [class*="backTop"]').forEach((el) => {
            if (el === dock || dock.contains(el)) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) return;
            if (rect.bottom < viewportHeight * 0.35) return;
            if (rect.right < viewportWidth - 160 || rect.left > viewportWidth - 4) return;
            topEdge = Math.min(topEdge, rect.top);
        });
        let bottom = DOCK_DEFAULT_BOTTOM;
        if (Number.isFinite(topEdge)) bottom = Math.max(bottom, Math.round(viewportHeight - topEdge) + 12);
        dock.style.bottom = bottom + 'px';
        dock.style.right = '22px';
    }

    function setSetting(key, value) {
        settings[key] = value;
        saveSettings();
        bus.emit('settings', key);
    }

    function switchRow(label, desc, key) {
        const input = h('input', { type: 'checkbox', dataset: { fbhKey: key } });
        input.checked = !!settings[key];
        input.addEventListener('change', () => setSetting(key, input.checked));
        const control = h('label', { class: 'fbh-switch' }, [input, h('i')]);
        return h('div', { class: 'fbh-row' }, [
            h('div', {}, [
                h('div', { class: 'fbh-row-label', text: label }),
                h('div', { class: 'fbh-row-desc', text: desc })
            ]),
            control
        ]);
    }

    function createDock() {
        if (dock) return dock;
        const status = h('div', { class: 'fbh-status' });
        const sortHot = h('button', { class: 'fbh-chip' + (settings.sort === 'hot' ? ' is-active' : ''), type: 'button', text: '高赞优先' });
        const sortNew = h('button', { class: 'fbh-chip' + (settings.sort === 'new' ? ' is-active' : ''), type: 'button', text: '最新优先' });
        const bindSort = (btn, value) => btn.addEventListener('click', () => setSetting('sort', value));
        bindSort(sortHot, 'hot');
        bindSort(sortNew, 'new');

        const pageSize = h('select', { class: 'fbh-select' }, [10, 20, 30, 50].map((n) => {
            const option = h('option', { value: String(n), text: `${n} 条` });
            if (n === Number(settings.pageSize)) option.selected = true;
            return option;
        }));
        pageSize.value = String(settings.pageSize);
        pageSize.addEventListener('change', () => setSetting('pageSize', Number(pageSize.value)));

        const panel = h('div', { class: 'fbh-dock-panel', role: 'dialog', 'aria-label': '粉笔助手设置' }, [
            h('div', { class: 'fbh-dock-head' }, [
                h('span', { class: 'fbh-dock-logo', html: ICONS.logo }),
                h('span', { class: 'fbh-dock-title', text: '粉笔助手' }),
                h('span', { class: 'fbh-dock-version', text: 'v' + VERSION }),
                h('button', { class: 'fbh-dock-close', type: 'button', 'aria-label': '关闭', html: ICONS.close, onclick: () => dock.classList.remove('is-open') })
            ]),
            h('div', { class: 'fbh-group' }, [
                h('div', { class: 'fbh-group-title', text: '功能开关' }),
                switchRow('自动展开解析', '修复折叠动画状态不同步，进页面直接看解析', 'autoExpand'),
                switchRow('题目讨论', '在每道题的解析面板内嵌可展开的评论区', 'comments'),
                switchRow('标题栏快捷入口', '题号右侧增加讨论图标，一键跳转', 'quickEntry'),
                switchRow('专注模式', '隐藏解析视频、推广与统计卡片', 'focusMode')
            ]),
            h('div', { class: 'fbh-group' }, [
                h('div', { class: 'fbh-group-title', text: '讨论区' }),
                h('div', { class: 'fbh-row' }, [h('div', { class: 'fbh-row-label', text: '默认排序' })]),
                h('div', { class: 'fbh-seg' }, [sortHot, sortNew]),
                h('div', { class: 'fbh-row' }, [
                    h('div', { class: 'fbh-row-label', text: '每次加载' }), pageSize
                ]),
                switchRow('只看优质评论', '过滤短评与纯提问，只留有信息量的留言', 'qualityOnly'),
                h('div', { class: 'fbh-actions' }, [
                    h('button', { class: 'fbh-action', type: 'button', text: '全部展开讨论', onclick: () => expandAllComments(true) }),
                    h('button', { class: 'fbh-action', type: 'button', text: '全部收起', onclick: () => expandAllComments(false) })
                ])
            ]),
            h('div', { class: 'fbh-group' }, [
                switchRow('调试日志', '在控制台输出题号映射与请求过程', 'debug'),
                status,
                h('button', {
                    class: 'fbh-reset', type: 'button', text: '恢复默认设置',
                    onclick: () => {
                        Object.assign(settings, DEFAULTS);
                        saveSettings();
                        bus.emit('settings', '*');
                        dock.classList.remove('is-open');
                        setTimeout(() => window.location.reload(), 150);
                    }
                })
            ])
        ]);

        dock = h('div', { class: 'fbh-dock', id: 'fbh-dock' }, [
            h('button', {
                class: 'fbh-fab', type: 'button', title: '粉笔助手', 'aria-label': '打开粉笔助手', html: ICONS.logo,
                onclick: (event) => { event.stopPropagation(); dock.classList.toggle('is-open'); }
            }),
            panel
        ]);
        document.body.appendChild(dock);

        document.addEventListener('click', (event) => {
            if (dock.classList.contains('is-open') && !dock.contains(event.target)) dock.classList.remove('is-open');
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dock.classList.remove('is-open');
            if (event.altKey && String(event.key).toLowerCase() === 'k') {
                event.preventDefault();
                dock.classList.toggle('is-open');
            }
        }, true);

        const updateStatus = debounce(() => {
            const loaded = Array.from(views.values()).filter((v) => v.loaded).length;
            status.textContent = '';
            status.appendChild(h('div', {
                text: `题号映射 ${data.orderIds.length} · 小节映射 ${data.episodes.size} · 已加载 ${loaded}/${views.size} 题讨论`
            }));
            status.appendChild(h('div', {
                text: `题库前缀 ${data.prefix} · 练习 ${data.exerciseKey || '—'} · 旁路捕获 ${data.captureCount} 次`
            }));
            if (data.lastEpisodeError) {
                status.appendChild(h('div', { text: '接口诊断：' + data.lastEpisodeError }));
            }
        }, 180);
        bus.on('status', updateStatus);
        bus.on('settings', () => {
            $$('.fbh-seg .fbh-chip', panel).forEach((btn) => btn.classList.remove('is-active'));
            (settings.sort === 'new' ? sortNew : sortHot).classList.add('is-active');
            syncSortChips();
            pageSize.value = String(settings.pageSize);
            $$('.fbh-switch input', panel).forEach((input) => {
                if (input.dataset.fbhKey) input.checked = !!settings[input.dataset.fbhKey];
            });
            applyAll();
            scheduleDom();
        });

        const reposition = debounce(placeDock, 150);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, { passive: true });
        placeDock();

        updateStatus();
        return dock;
    }

    /* ==============================================================
     * 8. 启动
     * ============================================================== */

    const scheduleDom = debounce(onDom, 140);

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            // 忽略完全由本脚本产生的变更，降低无谓重扫
            const external = mutations.some((m) => {
                if (m.type === 'attributes') return !m.target.closest || !m.target.closest('.fbh-section');
                return true;
            });
            if (external) scheduleDom();
        });
        observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['style', 'class']
        });
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('打开粉笔助手设置', () => {
            if (dock) dock.classList.add('is-open');
        });
        GM_registerMenuCommand('全部展开题目讨论', () => expandAllComments(true));
        GM_registerMenuCommand('全部收起题目讨论', () => expandAllComments(false));
    }

    function boot() {
        injectStyles();
        const styleNode = $('#fbh-style');
        if (styleNode && document.head && styleNode.parentElement !== document.head) document.head.appendChild(styleNode);
        applyAll();
        createDock();
        startObserver();
        registerMenu();

        document.addEventListener('click', (event) => {
            if (event.target.closest && event.target.closest('.answer-btn')) {
                setTimeout(scheduleDom, 600);
                setTimeout(scheduleDom, 1600);
            }
        });

        // 异步准备题号 → 小节映射，不阻塞界面
        data.prepare();
        setTimeout(() => {
            const ids = data.prewarmIds();
            if (ids.length) data.ensureEpisodes(ids);
        }, 1200);
        [400, 1500, 3500].forEach((delay) => setTimeout(scheduleDom, delay));
        log(`v${VERSION} 已启动`, { path: location.pathname, exercise: data.exerciseKey });

        const api = Object.freeze({ version: VERSION, settings, data, views, expandAllComments });
        window.__FBH__ = api;
        try { PAGE_WINDOW.__FBH__ = api; } catch (e) { /* 部分环境禁止写页面全局 */ }
    }

    data.installCapture();   // document-start：必须早于页面自身的数据请求
    injectStyles();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
