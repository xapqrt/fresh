const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const githubBase = "https://raw.githubusercontent.com/imnotkoolkid/KCH/main/data";

const dataUrls = {
  css: `${githubBase}/css.json`,
  cssExtra: "https://raw.githubusercontent.com/zVipexx/dawn-client/refs/heads/main/css.json",
  maps: "https://raw.githubusercontent.com/zVipexx/dawn-client/refs/heads/main/maps.json",
  skins: `${githubBase}/skins.json`,
  sounds: `${githubBase}/sounds.json`,
  textures: `${githubBase}/texture.json`,
  crosshairs: `${githubBase}/crosshair.json`,
  skyboxes: `${githubBase}/skyboxes.json`,
  killicons: `${githubBase}/kill_icons.json`,
};

const _cacheKeys = [];
const CACHE_MAX = 8;
const cached = {};
const _setCache = (key, data) => {
  if (!cached[key]) {
    if (_cacheKeys.length >= CACHE_MAX) {
      const evict = _cacheKeys.shift();
      delete cached[evict];
    }
    _cacheKeys.push(key);
  }
  cached[key] = data;
};

const getData = async (key) => {
  if (cached[key]) return cached[key];

  if (key === "css") {
    const [res1, res2] = await Promise.all([
      fetch(dataUrls.css),
      fetch(dataUrls.cssExtra),
    ]);
    const [json1, json2] = await Promise.all([res1.json(), res2.json()]);
    const data = [
      ...(Array.isArray(json1) ? json1 : []),
      ...(Array.isArray(json2) ? json2 : []),
    ];
    _setCache(key, data);
    return data;
  }

  const res = await fetch(dataUrls[key]);
  const json = await res.json();
  let data;
  if (Array.isArray(json)) {
    data = json;
  } else if (json.sounds) {
    data = json.sounds;
  } else if (json.skyboxes) {
    data = json.skyboxes;
  } else if (json.killIcons) {
    data = json.killIcons;
  } else {
    data = json;
  }
  _setCache(key, data);
  return data;
};

const filterItems = (data, key) => {
  if (key === "css") {
    return data.filter(i => convert(i, key).availability === "free");
  }
  return data;
};

const convert = (item, type) => {
  if (item._converted && item._converted._type === type) return item._converted;
  const _cache = (obj) => { obj._type = type; item._converted = obj; return obj; };
  switch (type) {
    case "css":
      return _cache({
        title: item.title,
        description: item.description,
        previewUrl: item.homeImage,
        ingameImage: item.ingameImage || null,
        tags: item.tags,
        owner: item.owner,
        label: item.label,
        availability: item.availability,
        downloadUrl: item.downloadUrl,
        discord: item.discord,
      });
    case "crosshairs":
      return _cache({
        title: item.id,
        previewUrl: item.Crosshair,
        tags: item.tags,
        owner: item.owner,
        label: item.label,
        availability: "free",
        downloadUrl: item.Crosshair,
        discord: item.discord,
      });
    case "textures":
      return _cache({
        title: item.id,
        previewUrl: item.textureImage,
        tags: item.tags,
        owner: item.owner,
        label: item.label,
        availability: "free",
        downloadUrl: item.textureImage,
        discord: item.discord,
      });
    case "skyboxes":
      return _cache({
        title: item.name,
        previewUrl: item.isPack ? item.images?.[0]?.url : item.url,
        tags: item.isPack ? ["Pack"] : ["Single"],
        owner: item.owner,
        label: item.isPack ? "pack" : "",
        availability: "free",
        downloadUrl: item.isPack ? null : item.url,
        discord: item.discord,
        isPack: item.isPack,
        images: item.images,
      });
    case "sounds":
      return _cache({
        title: item.name,
        previewUrl: null,
        tags: [],
        owner: item.owner,
        label: "",
        availability: "free",
        downloadUrl: null,
        audioFiles: item.audioFiles,
      });
    case "killicons":
      return _cache({
        title: item.name,
        previewUrl: item.url,
        tags: [],
        owner: item.owner,
        label: "",
        availability: "free",
        downloadUrl: item.url,
        discord: item.discord,
      });
    case "maps":
      return _cache({
        title: item.map,
        previewUrl: item.image || item.preview || null,
        tags: item.modes || [],
        owner: "",
        label: "",
        availability: "free",
        downloadUrl: item.file || item.code || null,
      });
    default:
      return _cache({
        title: item.name || item.title || item.id || "Unknown",
        previewUrl: item.homeImage || item.previewUrl || item.image || item.url || null,
        tags: item.tags || [],
        owner: item.owner || "",
        label: item.label || "",
        availability: item.availability || "free",
        downloadUrl: item.downloadUrl || item.url || null,
        discord: item.discord || "",
      });
  }
};

const isInstallType = (type) => ["css", "sounds", "crosshairs", "textures", "skyboxes", "killicons"].includes(type);
const hasDirectLink = (type) => ["crosshairs", "textures", "skyboxes", "killicons", "maps", "skins"].includes(type);

const downloadFile = async (url, dest) => {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(buf));
};

const toStyleUrl = (url) => {
  if (url.includes("raw.githubusercontent.com")) {
    return url.replace("https://raw.githubusercontent.com/", "https://rawcdn.githack.com/");
  }
  return url;
};

const applyCss = (downloadUrl) => {
  const styleUrl = toStyleUrl(downloadUrl);
  ipcRenderer.send("update-setting", "css_link", styleUrl);
  ipcRenderer.send("update-setting", "css_enabled", true);
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "css_link", value: styleUrl } }));
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "css_enabled", value: true } }));
};

const removeCss = () => {
  ipcRenderer.send("update-setting", "css_link", "");
  ipcRenderer.send("update-setting", "css_enabled", false);
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "css_link", value: "" } }));
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "css_enabled", value: false } }));
};

const applyCrosshair = (url) => {
  localStorage.setItem("SETTINGS___SETTING/CROSSHAIR___SETTING/STATIC_URL___SETTING", url);
  localStorage.setItem("SETTINGS___SETTING/SNIPER___SETTING/SCOPE_URL___SETTING", url);
};

const removeCrosshair = () => {
  localStorage.removeItem("SETTINGS___SETTING/CROSSHAIR___SETTING/STATIC_URL___SETTING");
  localStorage.removeItem("SETTINGS___SETTING/SNIPER___SETTING/SCOPE_URL___SETTING");
};

const applyTexture = (url) => {
  localStorage.setItem("SETTINGS___SETTING/BLOCKS___SETTING/TEXTURE_URL___SETTING", url);
};

const removeTexture = () => {
  localStorage.removeItem("SETTINGS___SETTING/BLOCKS___SETTING/TEXTURE_URL___SETTING");
};

const skyboxKeys = [
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG3___SETTING",
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG4___SETTING",
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG2___SETTING",
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG1___SETTING",
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG6___SETTING",
  "SETTINGS___SETTING/SKYBOX___SETTING/TEXTURE_IMG5___SETTING",
];

const applySkybox = (raw) => {
  if (raw.isPack && raw.images) {
    raw.images.forEach((img, i) => { if (skyboxKeys[i]) localStorage.setItem(skyboxKeys[i], img.url); });
    ipcRenderer.send("update-setting", "skybox_url", raw.images[0].url);
  } else {
    skyboxKeys.forEach(k => localStorage.setItem(k, raw.url));
    ipcRenderer.send("update-setting", "skybox_url", raw.url);
  }
};

const removeSkybox = () => {
  skyboxKeys.forEach(k => localStorage.removeItem(k));
  ipcRenderer.send("update-setting", "skybox_url", "");
};

const _ensureKillIconSheet = () => {
  let styleEl = document.getElementById("juice-styles-ui-features");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "juice-styles-ui-features";
    document.head.appendChild(styleEl);
  }
  if (!styleEl.sheet) {
    styleEl.textContent = '';
    document.head.appendChild(styleEl);
  }
  return styleEl;
};

const applyKillIcon = (url) => {
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "killicon_link", value: url } }));

  const styleEl = _ensureKillIconSheet();
  const sheet = styleEl.sheet;
  const beforeRule = `.animate-cont::before { content: ""; background: url(${url}); width: 10rem; height: 10rem; margin-bottom: 2rem; display: inline-block; background-position: center; background-size: contain; background-repeat: no-repeat; }`;
  const svgRule = `.animate-cont svg { display: none; }`;

  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    const r = sheet.cssRules[i];
    if (r.selectorText === '.animate-cont::before' || r.selectorText === '.animate-cont svg') {
      sheet.deleteRule(i);
    }
  }
  sheet.insertRule(beforeRule, sheet.cssRules.length);
  sheet.insertRule(svgRule, sheet.cssRules.length);
};

const removeKillIcon = () => {
  document.dispatchEvent(new CustomEvent("juice-settings-changed", { detail: { setting: "killicon_link", value: "" } }));

  const styleEl = document.getElementById("juice-styles-ui-features");
  if (styleEl && styleEl.sheet) {
    const sheet = styleEl.sheet;
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (r.selectorText === '.animate-cont::before' || r.selectorText === '.animate-cont svg') {
        sheet.deleteRule(i);
      }
    }
  }
};

const soundsDir = ipcRenderer.sendSync("get-sounds-path");


const installSounds = async (audioFiles) => {
  fs.mkdirSync(soundsDir, { recursive: true });
  for (const file of audioFiles) {
    if (!file.url.endsWith(".mp3")) continue;
    const filename = path.basename(decodeURIComponent(file.url.split("?")[0]));
    await downloadFile(file.url, path.join(soundsDir, filename));
  }
};

const uninstallSounds = (audioFiles) => {
  for (const file of audioFiles) {
    if (!file.url.endsWith(".mp3")) continue;
    const filename = path.basename(decodeURIComponent(file.url.split("?")[0]));
    const filePath = path.join(soundsDir, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
};

const isInstalled = (type, item) => {
  const settings = ipcRenderer.sendSync("get-settings");
  switch (type) {
    case "css":
      return (
        settings.css_enabled &&
        (settings.css_link === item.downloadUrl || settings.css_link === toStyleUrl(item.downloadUrl))
      );
    case "crosshairs":
      return localStorage.getItem("SETTINGS___SETTING/CROSSHAIR___SETTING/STATIC_URL___SETTING") === item.downloadUrl;
    case "textures":
      return localStorage.getItem("SETTINGS___SETTING/BLOCKS___SETTING/TEXTURE_URL___SETTING") === item.downloadUrl;
    case "skyboxes":
      return localStorage.getItem(skyboxKeys[0]) === (item.isPack ? item.images?.[0]?.url : item.downloadUrl);
    case "killicons":
      return settings.killicon_link === item.downloadUrl;
    case "sounds": {
      if (!item.audioFiles?.length) return false;
      const first = item.audioFiles.find(f => f.url.endsWith(".mp3"));
      if (!first) return false;
      const filename = path.basename(decodeURIComponent(first.url.split("?")[0]));
      try { return fs.existsSync(path.join(soundsDir, filename)); } catch { return false; }
    }
    default:
      return false;
  }
};

let lightboxItems = [];
let lightboxIndex = 0;

window.openLightbox = (urls, index = 0) => {
  lightboxItems = Array.isArray(urls) ? urls : [urls];
  lightboxIndex = index;

  let overlay = document.getElementById("juice-lightbox");
    if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "juice-lightbox";
    overlay.innerHTML = `
      <div class="juice-lightbox-backdrop"></div>
      <img class="juice-lightbox-img" draggable="false" />
      <span id="info">Ctrl+C to copy</span>
    `;

    document.body.appendChild(overlay);

    const close = () => {
      overlay.style.visibility = "hidden";
      overlay.style.opacity = "0";
      overlay.style.pointerEvents = "none";
      overlay.classList.remove("active");
    };

    window.keyHandler = (e) => {
      if (e.key === "Escape" && overlay.classList.contains("active")) close();
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && overlay.classList.contains("active")) {
        e.preventDefault();
        const img = overlay.querySelector(".juice-lightbox-img");
        if (img) {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob })
            ]);
          });
          overlay.querySelector("#info").textContent = "Copied to clipboard!"
          customNotification({
            message: "Image copied to clipboard!",
            icon: img.src,
          });
        }
      }
    };

    overlay.addEventListener("click", close);
  } else overlay.querySelector("#info").textContent = "Ctrl+C to copy";
  if (document._lightboxKeyHandler) {
    document.removeEventListener("keydown", document._lightboxKeyHandler);
  }
  document._lightboxKeyHandler = keyHandler;
  document.addEventListener("keydown", keyHandler);

  updateLightbox();
  overlay.classList.add("active");
  overlay.style.visibility = "visible";
  overlay.style.opacity = "1";
  overlay.style.pointerEvents = "auto";
};

const updateLightbox = () => {
  const overlay = document.getElementById("juice-lightbox");
  if (!overlay) return;
  overlay.querySelector(".juice-lightbox-img").src = lightboxItems[lightboxIndex];
};

const _handleCardClick = (container, e, items, allRaw, type) => {
  const card = e.target.closest(".community-card");
  if (!card) return;
  const index = parseInt(card.dataset.index, 10);
  if (isNaN(index)) return;
  const raw = allRaw[index];
  const item = convert(raw, type);

  const dotsBtn = e.target.closest(".card-preview-dots");
  if (dotsBtn) {
    e.stopPropagation();
    const cardImg = card.querySelector(".card-img");
    const dots = card.querySelectorAll(".preview-dot");
    const srcs = [item.previewUrl, item.ingameImage];
    let current = parseInt(card.dataset.previewIdx || '0', 10);
    current = (current + 1) % 2;
    card.dataset.previewIdx = current;
    cardImg.src = srcs[current];
    dots.forEach((d, i) => d.classList.toggle("active", i === current));
    return;
  }

  const label = e.target.closest(".card-label");
  if (label) return;

  const previewDiv = e.target.closest(".card-preview");
  if (previewDiv) {
    const imgs = [];
    if (item.isPack && item.images?.length) {
      item.images.forEach(img => imgs.push(img.url));
    } else if (item.previewUrl && item.ingameImage) {
      imgs.push(card.querySelector(".card-img").src);
    } else if (item.previewUrl) {
      imgs.push(item.previewUrl);
    }
    openLightbox(imgs, 0);
    return;
  }

  const linkBtn = e.target.closest(".card-link-btn");
  if (linkBtn) {
    navigator.clipboard.writeText(item.downloadUrl);
    linkBtn.innerHTML = `<i class="fas fa-check"></i>`;
    linkBtn.classList.add("copied");
    setTimeout(() => {
      linkBtn.innerHTML = `<i class="fas fa-link"></i>`;
      linkBtn.classList.remove("copied");
    }, 1500);
    return;
  }

  const externalBtn = e.target.closest(".card-external-btn");
  if (externalBtn) {
    ipcRenderer.send("open-external", "https://kirkacommunityhub.pages.dev/assets#sounds");
    return;
  }

  const mapCopyBtn = e.target.closest(".card-map-copy-btn");
  if (mapCopyBtn) {
    mapCopyBtn.textContent = "...";
    mapCopyBtn.disabled = true;
    fetch(item.downloadUrl).then(res => res.text()).then(text => {
      navigator.clipboard.writeText(text);
      mapCopyBtn.textContent = "Copied!";
      mapCopyBtn.classList.add("uninstall");
      mapCopyBtn.classList.remove("free");
      setTimeout(() => {
        mapCopyBtn.textContent = "Copy";
        mapCopyBtn.classList.remove("uninstall");
        mapCopyBtn.classList.add("free");
        mapCopyBtn.disabled = false;
      }, 1500);
    }).catch(e => {
      console.error(e);
      mapCopyBtn.textContent = "Error";
      mapCopyBtn.disabled = false;
      setTimeout(() => { mapCopyBtn.textContent = "Copy"; mapCopyBtn.disabled = false; }, 2000);
    });
    return;
  }

  const btn = e.target.closest(".card-btn:not(.card-map-copy-btn)");
  if (!btn || btn.disabled) return;
  if (type === "maps") return;

  const currentlyInstalled = isInstalled(type, item);
  if (currentlyInstalled) {
    switch (type) {
      case "css": removeCss(); break;
      case "crosshairs": removeCrosshair(); break;
      case "textures": removeTexture(); break;
      case "skyboxes": removeSkybox(); break;
      case "killicons": removeKillIcon(); break;
      case "sounds": uninstallSounds(raw.audioFiles); break;
    }
    btn.textContent = isInstallType(type) ? "Install" : "Download";
    btn.className = `card-btn ${item.availability || "free"}`;
    return;
  }

  btn.textContent = "...";
  btn.disabled = true;

  const doAction = async () => {
    try {
      switch (type) {
        case "css": applyCss(item.downloadUrl); break;
        case "crosshairs": applyCrosshair(item.downloadUrl); break;
        case "textures": applyTexture(item.downloadUrl); break;
        case "skyboxes": applySkybox(raw); break;
        case "killicons": applyKillIcon(item.downloadUrl); break;
        case "sounds": await installSounds(raw.audioFiles); break;
        default: {
          const ext = item.downloadUrl.split(".").pop().split("?")[0];
          const filename = `${item.title.replace(/[^a-z0-9]/gi, "_")}.${ext}`;
          const dest = path.join(os.homedir(), "Downloads", filename);
          await downloadFile(item.downloadUrl, dest);
        }
      }
      btn.textContent = isInstallType(type) ? "Uninstall" : "Download";
      btn.className = "card-btn uninstall";
      btn.disabled = false;

      if (["css", "crosshairs", "textures", "skyboxes", "killicons"].includes(type)) {
        const parent = btn.closest(`#${type}-options`);
        if (parent) {
          parent.querySelectorAll(".card-btn.uninstall").forEach(otherBtn => {
            if (otherBtn !== btn) {
              otherBtn.textContent = "Install";
              otherBtn.className = `card-btn free`;
            }
          });
        }
      }
    } catch (e) {
      console.error(e);
      btn.textContent = "Error";
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = isInstallType(type) ? "Install" : "Download";
        btn.disabled = false;
      }, 2000);
    }
  };
  doAction();
};

const renderCards = (container, items, type, allRaw) => {
  container.replaceChildren();

  container._cardItems = items;
  container._cardAllRaw = allRaw;
  container._cardType = type;

  items.forEach((raw, idx) => {
    const item = convert(raw, type);
    const card = document.createElement("div");
    card.className = `community-card ${item.availability || "free"}`;
    card.dataset.index = idx;

    const showPreview = type !== "commscripts" && type !== "sounds";
    const isPaid = item.availability === "paid";
    const isShowcase = item.availability === "showcase";
    const cantInstall = isPaid || isShowcase || (!item.downloadUrl && type !== "sounds" && type !== "skyboxes");

    const installed = !cantInstall && isInstalled(type, item);

    const hasIngame = type === "css" && !!item.ingameImage;
    let previewHtml = "";
    if (showPreview) {
      if (!item.previewUrl) {
        previewHtml = `<div class="card-no-preview">No Preview</div>`;
      } else {
        previewHtml = `<img src="${item.previewUrl}" alt="${item.title}" draggable="false" class="card-img" />`;
        if (hasIngame) {
          previewHtml += `<div class="card-preview-dots">
                  <span class="preview-dot active"></span>
                  <span class="preview-dot"></span>
                </div>`;
        }
      }
    }

    let btnHtml = "";
    if (type === "maps") {
      if (item.downloadUrl) {
        btnHtml = `<button class="card-btn free card-map-copy-btn">Copy</button>`;
      }
    } else {
      let btnText;
      if (cantInstall) {
        btnText = isPaid ? "Paid" : "Showcase";
      } else if (installed) {
        btnText = "Uninstall";
      } else {
        btnText = isInstallType(type) ? "Install" : "Download";
      }

      let btnClass;
      if (cantInstall) {
        btnClass = item.availability;
      } else if (installed) {
        btnClass = "uninstall";
      } else {
        btnClass = item.availability || "free";
      }

      btnHtml = `<button class="card-btn ${btnClass}" ${cantInstall ? "disabled" : ""}>${btnText}</button>`;
    }

    let linkBtn = "";
    if (hasDirectLink(type) && item.downloadUrl && !cantInstall && type !== "maps") {
      linkBtn = `<button class="card-link-btn" title="Copy link"><i class="fas fa-link"></i></button>`;
    }

    let soundsPreviewBtn = "";
    if (type === "sounds") {
      soundsPreviewBtn = `<button class="card-external-btn" title="Preview online"><i class="fas fa-external-link-alt"></i></button>`;
    }

    card.innerHTML = `
        ${showPreview ? `<div class="card-preview">${previewHtml}${item.label ? `<span class="card-label">${item.label}</span>` : ""}</div>` : ""}
        <div class="card-info">
          <div class="card-title">${item.title}</div>
          ${item.description ? `<div class="card-desc">${item.description}</div>` : ""}
          ${item.tags?.length ? `<div class="card-tags">${item.tags.map(t => `<span class="card-tag">${t}</span>`).join("")}</div>` : ""}
          <div class="card-footer">
            <span class="card-owner">${(item.owner && item.owner !== "Unknown") ? item.owner : ""}</span>
            <div class="card-actions">
              ${soundsPreviewBtn}
              ${linkBtn}
              ${btnHtml}
            </div>
          </div>
        </div>
      `;

    container.appendChild(card);
  });
};

const initBrowser = (menu) => {
  const selectors = menu.querySelectorAll(".community-sidebar .juice.selector");
  const panels = menu.querySelectorAll("#community-options .content .juice.options");
  const searchInput = menu.querySelector(".juice.search") || menu.querySelector(".juice.community-search");

  let currentKey = "css";
  let currentItems = [];

  menu.addEventListener("click", (e) => {
    if (e.target.closest(".fas")) return;

    if (e.target.tagName.toLowerCase() === "img" && e.target.closest("#community-options, #gallery-options")) {
      e.stopPropagation();
      openLightbox(e.target.src, 0);
    } else if (e.target.tagName.toLowerCase() === "canvas" && e.target.closest("#community-options, #gallery-options")) {
      e.stopPropagation();
      openLightbox(e.target.toDataURL(), 0)
    }
  });

  const loadSection = async (key) => {
    currentKey = key;
    const container = menu.querySelector(`#${key}-options`);
    if (!container) return;
    try {
      const data = await getData(key);
      currentItems = data;
      const query = searchInput?.value?.toLowerCase() || "";
      let filtered;
      if (query) {
        filtered = data.filter(i => {
          const n = convert(i, key);
          return n.title?.toLowerCase().includes(query) || n.tags?.some(t => t.toLowerCase().includes(query));
        });
      } else {
        filtered = data;
      }
      filtered = filterItems(filtered, key);
      renderCards(container, filtered, key, data);
    } catch (e) {
      console.error(e);
      container.textContent = "Failed to load.";
    }
  };

  const communityOptions = menu.querySelector("#community-options");
  if (communityOptions) {
    communityOptions.addEventListener("click", (e) => {
      const container = e.target.closest(".juice.options.selected");
      if (!container) return;
      const items = container._cardItems;
      const allRaw = container._cardAllRaw;
      const type = container._cardType;
      if (!items || !allRaw || !type) return;
      _handleCardClick(container, e, items, allRaw, type);
    });
  }

  selectors.forEach((sel) => {
    sel.addEventListener("click", () => {
      selectors.forEach(s => s.classList.remove("active"));
      panels.forEach(p => p.classList.remove("selected"));
      sel.classList.add("active");
      const key = sel.dataset.selector;
      const panel = menu.querySelector(`#${key}-options`);
      if (panel) panel.classList.add("selected");
      loadSection(key);
    });
  });

  if (searchInput) {
    let _searchRaf = null;
    searchInput.addEventListener("input", () => {
      if (_searchRaf) return;
      _searchRaf = requestAnimationFrame(() => {
        _searchRaf = null;
        const query = searchInput.value.toLowerCase();
        const container = menu.querySelector(`#${currentKey}-options`);
        if (!container || !currentItems.length) return;
        let filtered;
        if (query) {
          filtered = currentItems.filter(i => {
            const n = convert(i, currentKey);
            return n.title?.toLowerCase().includes(query) || n.tags?.some(t => t.toLowerCase().includes(query));
          });
        } else {
          filtered = currentItems;
        }
        renderCards(container, filtered, currentKey, currentItems);
      });
    });
  }

  const lastOpenedSelector = localStorage.getItem("juice-menu-selector");
  loadSection(lastOpenedSelector);
};

module.exports = { initBrowser };