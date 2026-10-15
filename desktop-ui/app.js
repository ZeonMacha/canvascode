/**
 * CanvasCode Studio — Desktop Workbench Orchestration Engine
 * Copyright (C) 2026 Allen (@al1830329386-dev)
 * Licensed under GNU General Public License v3.0 (GPL-3.0).
 */

(function () {
  // State
  let currentZoom = 1.0;
  let currentDevice = "desktop";
  let diffHistory = [];
  let isSnappingEnabled = true;
  let currentHtmlPath = "";

  // DOM References
  const targetUrlInput = document.getElementById("target-url-input");
  const btnLoadUrl = document.getElementById("btn-load-url");
  const btnOpenFile = document.getElementById("btn-open-file");
  const btnHome = document.getElementById("btn-home");
  const previewIframe = document.getElementById("preview-iframe");
  const deviceFrame = document.getElementById("device-frame");
  const deviceUrlDisplay = document.getElementById("device-url-display");
  const canvasArtboard = document.getElementById("canvas-artboard");
  const canvasViewport = document.getElementById("canvas-viewport");

  // Zoom controls
  const btnZoomIn = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnZoomReset = document.getElementById("btn-zoom-reset");
  const zoomLevelText = document.getElementById("zoom-level-text");

  // Canvas Actions
  const btnSnapToggle = document.getElementById("btn-snap-toggle");
  const btnUndo = document.getElementById("btn-undo");
  const btnRedo = document.getElementById("btn-redo");
  const btnExportPrompt = document.getElementById("btn-export-prompt");
  const btnSyncCode = document.getElementById("btn-sync-code");

  // Sidebar Tabs
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");

  const dockEmpty = document.getElementById("docked-toolbar-empty");
  const dockHost = document.getElementById("docked-toolbar-host");
  const dockShadow = dockHost ? dockHost.attachShadow({ mode: "open" }) : null;
  let dockCss = "";

  // Diff & Sync
  const diffBadge = document.getElementById("diff-badge");
  const diffCount = document.getElementById("diff-count");
  const diffListContainer = document.getElementById("diff-list-container");
  const btnClearAllDiff = document.getElementById("btn-clear-all-diff");
  const syncProjectPath = document.getElementById("sync-project-path");
  const btnBrowseFolder = document.getElementById("btn-browse-folder");
  const syncDiffDisplay = document.getElementById("sync-diff-display");
  const btnApplySync = document.getElementById("btn-apply-sync");

  // --- 1. Device Preset Switching ---
  document.querySelectorAll(".device-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".device-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const device = btn.getAttribute("data-device");
      setDevicePreset(device);
    });
  });

  function setDevicePreset(device) {
    currentDevice = device;
    deviceFrame.className = `device-frame ${device}`;
    fitZoomForDevice(device);
  }

  function deviceFrameSize() {
    if (currentDevice === "tablet") return { w: 820, h: 1180 };
    if (currentDevice === "mobile") return { w: 393, h: 852 };
    if (currentDevice === "responsive") return null;
    return { w: 1440, h: 900 };
  }

  function fitZoomForDevice(device) {
    if (device === "responsive") {
      applyZoom(1);
      return;
    }
    const size = deviceFrameSize();
    const availW = Math.max(120, canvasViewport.clientWidth - 48);
    const availH = Math.max(120, canvasViewport.clientHeight - 48);
    const bestScale = Math.min(availW / size.w, availH / size.h, 1);
    applyZoom(Math.max(0.15, Math.floor(bestScale * 100) / 100));
  }

  // --- 2. Canvas Zooming ---
  function applyZoom(zoom) {
    currentZoom = Math.min(2, Math.max(0.15, zoom));
    zoomLevelText.textContent = `${Math.round(currentZoom * 100)}%`;
    if (currentDevice === "responsive") {
      canvasArtboard.style.width = "100%";
      canvasArtboard.style.height = "100%";
      deviceFrame.style.zoom = "";
      deviceFrame.style.transform = "none";
      canvasViewport.style.alignItems = "stretch";
      canvasViewport.style.justifyContent = "stretch";
      return;
    }
    deviceFrame.style.zoom = String(currentZoom);
    deviceFrame.style.transform = "none";
    canvasArtboard.style.width = "";
    canvasArtboard.style.height = "";
    const rect = canvasArtboard.getBoundingClientRect();
    const overflows = rect.width > canvasViewport.clientWidth - 8 || rect.height > canvasViewport.clientHeight - 8;
    canvasViewport.style.alignItems = overflows ? "flex-start" : "safe center";
    canvasViewport.style.justifyContent = overflows ? "flex-start" : "safe center";
  }

  btnZoomIn.onclick = () => applyZoom(currentZoom + 0.1);
  btnZoomOut.onclick = () => applyZoom(currentZoom - 0.1);
  btnZoomReset.onclick = () => fitZoomForDevice(currentDevice);

  // --- 3. URL Loading & Engine Injection ---
  const urlProtocol = document.getElementById("url-protocol");
  const dropOverlay = document.getElementById("drop-overlay");
  let bridgeWindow = null;
  let loadToken = 0;

  function tauriApi() {
    return window.__TAURI__ || null;
  }

  function loadUrl(rawUrl) {
    let url = rawUrl.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
      url = "http://" + url;
    }
    if (urlProtocol) urlProtocol.textContent = "http://";
    deviceUrlDisplay.textContent = url;
    previewIframe.removeAttribute("srcdoc");
    previewIframe.src = url;
  }

  async function openLocalHtml(path) {
    const api = tauriApi();
    if (!api?.core) throw new Error("当前不是桌面端，无法按文件路径加载页面。");
    const page = await api.core.invoke("prepare_local_page", { path });
    currentHtmlPath = path;
    if (syncProjectPath) syncProjectPath.value = path;
    if (urlProtocol) urlProtocol.textContent = "本地";
    targetUrlInput.value = page.name;
    deviceUrlDisplay.textContent = path;
    previewIframe.removeAttribute("srcdoc");
    previewIframe.src = page.url;
  }
  window.__canvascodeOpenLocalHtml = openLocalHtml;

  function goHome() {
    if (currentHtmlPath) {
      openLocalHtml(currentHtmlPath).catch((err) => alert("无法回到首页：" + err));
      return;
    }
    const current = previewIframe.src || "";
    if (current && current !== "about:blank") {
      previewIframe.src = current.split("#")[0];
      return;
    }
    alert("还没有打开页面。");
  }

  if (btnHome) btnHome.onclick = () => goHome();

  btnLoadUrl.onclick = () => loadUrl(targetUrlInput.value);
  targetUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadUrl(targetUrlInput.value);
  });

  btnOpenFile.onclick = async () => {
    const api = tauriApi();
    if (api?.core) {
      try {
        const path = await api.core.invoke("pick_html_file");
        if (path) await openLocalHtml(path);
      } catch (err) {
        alert("无法打开文件：" + err);
      }
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,.htm";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fileUrl = URL.createObjectURL(file);
      targetUrlInput.value = file.name;
      deviceUrlDisplay.textContent = file.name + "（浏览器预览无法加载同目录资源）";
      previewIframe.removeAttribute("srcdoc");
      previewIframe.src = fileUrl;
    };
    input.click();
  };

  async function engineSource() {
    const api = tauriApi();
    if (api?.core) return api.core.invoke("tweak_engine_source");
    const res = await fetch(new URL("../tweak-engine.js", window.location.href).href);
    if (!res.ok) throw new Error("找不到微调引擎");
    return res.text();
  }

  // Inject Tweak Engine into preview iframe on load
  previewIframe.onload = async () => {
    const token = ++loadToken;
    renderDockedToolbar("");
    try {
      const iDoc = previewIframe.contentDocument;
      if (!iDoc || !iDoc.body || iDoc.location.href === "about:blank") return;

      if (!iDoc.getElementById("canvascode-engine-script") && !iDoc.getElementById("ai-visual-tweak-host")) {
        const source = await engineSource();
        if (token !== loadToken) return;
        const doc = previewIframe.contentDocument;
        if (!doc || !doc.body || doc.getElementById("ai-visual-tweak-host") || doc.getElementById("canvascode-engine-script")) return;
        const script = doc.createElement("script");
        script.id = "canvascode-engine-script";
        script.textContent = source;
        doc.body.appendChild(script);
      }
      setupIframeBridge(previewIframe.contentWindow);
    } catch (err) {
      console.warn("无法注入微调引擎，页面本身仍可操作。", err);
    }
  };

  function showDropOverlay(visible) {
    if (dropOverlay) dropOverlay.hidden = !visible;
  }

  async function installFileDrop() {
    const api = tauriApi();
    if (!api?.webview?.getCurrentWebview) return;
    await api.webview.getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload || {};
      if (payload.type === "enter" || payload.type === "over") {
        showDropOverlay(true);
        return;
      }
      if (payload.type === "leave") {
        showDropOverlay(false);
        return;
      }
      if (payload.type !== "drop") return;
      showDropOverlay(false);
      const html = (payload.paths || []).find((file) => /\.html?$/i.test(file));
      if (!html) {
        alert("请拖入 .html 或 .htm 文件。勾选表需要和同目录的 css、js 一起打开。");
        return;
      }
      openLocalHtml(html).catch((err) => alert("无法打开页面：" + err));
    });
  }

  // --- 4. Sidebar Tabs Switching ---
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.remove("active"));
      tabPanes.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const tabId = "tab-" + btn.getAttribute("data-tab");
      document.getElementById(tabId).classList.add("active");
    });
  });

  // --- 5. Bridge & Bidirectional Inspector Binding ---
  function postToPreview(type, extra) {
    try {
      previewIframe.contentWindow.postMessage(Object.assign({ source: "canvascode-parent", type }, extra || {}), "*");
    } catch (err) {}
  }

  window.addEventListener("message", (event) => {
    if (event.source !== previewIframe.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== "canvascode") return;
    if (data.type === "toolbar" && data.detail) {
      renderDockedToolbar(data.detail.html || "", data.detail.css || "");
    }
    if (data.type === "cleanHtml" && data.detail && pendingHtml && pendingHtml.id === data.detail.requestId) {
      pendingHtml.resolve(data.detail.html || "");
    }
    if (data.type === "stateChanged" && data.detail) {
      diffHistory = data.detail.history || [];
      updateDiffChangelog();
      btnUndo.disabled = !data.detail.canUndo;
      btnRedo.disabled = !data.detail.canRedo;
    }
  });

  function renderDockedToolbar(html, css) {
    if (!dockHost || !dockShadow) return;
    if (css) dockCss = css;
    if (!html) {
      dockHost.hidden = true;
      if (dockEmpty) dockEmpty.hidden = false;
      return;
    }
    if (dockEmpty) dockEmpty.hidden = true;
    dockHost.hidden = false;
    const pane = document.getElementById("tab-inspector");
    const scroll = pane ? pane.scrollTop : 0;
    dockShadow.innerHTML = `<style>${dockCss}</style><style>
      .toolbar { position: static !important; width: 100% !important; max-width: 100%; display: flex !important; left: auto !important; top: auto !important; animation: none !important; box-shadow: none !important; border-radius: 12px; }
    </style><div class="toolbar">${html}</div>`;
    if (pane) pane.scrollTop = scroll;
  }

  function forwardToolbarPointer(eventName, event) {
    const node = event.target && event.target.closest ? event.target.closest("[data-cc]") : null;
    if (!node) return;
    if (eventName === "click" && node.matches("input, textarea")) return;
    if (eventName === "input" && node.id === "r-slider") {
      const badge = dockShadow.querySelector("#r-val-badge");
      if (badge) badge.textContent = node.value + "px";
    }
    postToPreview("toolbar", { kind: eventName, cc: node.getAttribute("data-cc"), value: node.value });
  }

  if (dockShadow) {
    dockShadow.addEventListener("click", (event) => forwardToolbarPointer("click", event));
    dockShadow.addEventListener("input", (event) => forwardToolbarPointer("input", event));
    dockShadow.addEventListener("change", (event) => forwardToolbarPointer("change", event));
  }

  let pendingHtml = null;
  function requestCleanHtml() {
    return new Promise((resolve, reject) => {
      const id = String(Date.now()) + Math.random().toString(16).slice(2);
      const timer = setTimeout(() => {
        if (pendingHtml && pendingHtml.id === id) pendingHtml = null;
        reject(new Error("页面没有返回可保存的 HTML"));
      }, 4000);
      pendingHtml = {
        id,
        resolve(html) {
          clearTimeout(timer);
          pendingHtml = null;
          resolve(html);
        }
      };
      postToPreview("exportHtml", { requestId: id });
    });
  }

  function setupIframeBridge(iWin) {
    if (!iWin || bridgeWindow === iWin) return;
    bridgeWindow = iWin;

    iWin.addEventListener("canvascode:stateChanged", (e) => {
      const detail = e.detail;
      if (!detail) return;
      diffHistory = detail.history || [];
      updateDiffChangelog();
      btnUndo.disabled = !detail.canUndo;
      btnRedo.disabled = !detail.canRedo;
    });
  }

  // --- 6. Diff Changelog & Sync Panel ---
  function updateDiffChangelog() {
    diffBadge.textContent = diffHistory.length;
    diffCount.textContent = diffHistory.length;

    if (diffHistory.length === 0) {
      diffListContainer.innerHTML = `<div class="empty-state">暂无改动，在画布上直接拖拽或修改元素即可生成记录</div>`;
      syncDiffDisplay.textContent = "/* 暂无代码待同步 */";
      return;
    }

    diffListContainer.innerHTML = diffHistory.map((item, index) => `
      <div class="diff-card">
        <div class="diff-card-header">
          <span>${item.selector || "元素 #" + (index + 1)}</span>
          <button class="btn-text-danger" onclick="revertDiffItem(${index})">还原</button>
        </div>
        <div style="color:#94a3b8;font-size:11px;">${item.summary || "样式已微调"}</div>
      </div>
    `).join("");

    // Update code sync diff display
    syncDiffDisplay.textContent = diffHistory.map(item => {
      return `// 目标: ${item.selector}\n+ ${item.tailwindClasses || item.cssText || "custom styles"}`;
    }).join("\n\n");
  }

  window.revertDiffItem = function(index) {
    postToPreview("revert", { index });
  };

  btnClearAllDiff.onclick = () => {
    postToPreview("reset");
  };

  // --- 7. Buttons: Snapping, Undo, Redo, Export, Sync ---
  btnSnapToggle.onclick = () => {
    isSnappingEnabled = !isSnappingEnabled;
    btnSnapToggle.classList.toggle("active", isSnappingEnabled);
    postToPreview("snap", { enabled: isSnappingEnabled });
  };

  btnUndo.onclick = () => postToPreview("undo");

  btnRedo.onclick = () => postToPreview("redo");

  btnExportPrompt.onclick = () => postToPreview("export");

  btnSyncCode.onclick = () => {
    // Switch to sync tab
    tabBtns.forEach(b => b.classList.remove("active"));
    tabPanes.forEach(p => p.classList.remove("active"));
    const syncTabBtn = document.querySelector('.tab-btn[data-tab="sync"]');
    if (syncTabBtn) syncTabBtn.classList.add("active");
    document.getElementById("tab-sync").classList.add("active");
  };

  btnBrowseFolder.onclick = async () => {
    const api = tauriApi();
    if (!api?.core) {
      alert("浏览本地 HTML 需要在桌面端运行。");
      return;
    }
    try {
      const path = await api.core.invoke("pick_html_file");
      if (!path) return;
      syncProjectPath.value = path;
      currentHtmlPath = path;
    } catch (err) {
      alert("无法选择文件：" + err);
    }
  };

  btnApplySync.onclick = async () => {
    const target = (syncProjectPath.value || currentHtmlPath || "").trim();
    if (!/\.html?$/i.test(target)) {
      alert("请先打开一个 HTML 文件，或在这里填入要写回的 .html / .htm 路径。");
      return;
    }
    const api = tauriApi();
    if (!api?.core) {
      alert("写回本地 HTML 需要在桌面端运行。");
      return;
    }
    try {
      const html = await requestCleanHtml();
      if (!html || !html.trim()) throw new Error("页面内容是空的");
      const res = await api.core.invoke("write_local_html", { path: target, html });
      currentHtmlPath = target;
      alert("已写回 HTML 文件。\n" + res);
    } catch (err) {
      alert("写回失败: " + err);
    }
  };

  window.addEventListener("keydown", (event) => {
    const typing = event.target && event.target.closest && event.target.closest("input, textarea, select");
    const shadowField = dockShadow && dockShadow.activeElement;
    const shadowTyping = shadowField && shadowField.matches && shadowField.matches("input, textarea, select");
    const selectedText = window.getSelection ? String(window.getSelection()) : "";
    if (typing || shadowTyping) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      postToPreview("navigateSelection", {
        key: event.key,
        shift: event.shiftKey,
        hierarchy: !!(event.ctrlKey || event.metaKey || event.altKey)
      });
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "c" && !event.shiftKey && selectedText) return;
    if (key === "c" && event.shiftKey) { event.preventDefault(); postToPreview("clipboard", { op: "copyStyle" }); }
    else if (key === "v" && event.shiftKey) { event.preventDefault(); postToPreview("clipboard", { op: "pasteStyle" }); }
    else if (key === "c") { event.preventDefault(); postToPreview("clipboard", { op: "copy" }); }
    else if (key === "x") { event.preventDefault(); postToPreview("clipboard", { op: "cut" }); }
    else if (key === "v") { event.preventDefault(); postToPreview("clipboard", { op: "paste" }); }
  });

  // Initial responsive zoom fit on load
  window.addEventListener("resize", () => {
    fitZoomForDevice(currentDevice);
  });
  setTimeout(() => fitZoomForDevice("desktop"), 300);
  installFileDrop().catch((err) => console.warn("文件拖放未启用", err));
  const api = tauriApi();
  if (api?.core) {
    api.core.invoke("take_startup_file").then((path) => {
      if (path) return openLocalHtml(path);
    }).catch((err) => console.warn("启动文件打开失败", err));
  }
})();
