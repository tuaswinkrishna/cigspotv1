import * as maplibregl from "https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";

const $ = (selector) => document.querySelector(selector);
const deviceIdKey = "cigspot-device-id";
const currentDeviceId = getDeviceId();
const mapStart = { lng: 76.2673, lat: 9.9312 };
const state = {
  map: null,
  popup: null,
  currentLocationMarker: null,
  pendingLocation: null,
  currentLocation: mapStart,
  selectedSpot: null,
  spots: [],
  totalSpotCount: null,
  radiusKm: 1,
  mapFilter: "all",
  sort: "all",
  photoUrl: "",
  mvtVersion: Date.now(),
  clusterTimer: 0,
};

function getDeviceId() {
  let id = localStorage.getItem(deviceIdKey);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(deviceIdKey, id);
  }
  return id;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options.headers },
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function showDialog(title, content) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = content;
  $("#content-dialog").classList.add("active");
}

function closeDialog() {
  $("#content-dialog").classList.remove("active");
  $("#dialog-content").replaceChildren();
}

function setModalBusy(button, busy, busyText = "saving…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

function score(spot) {
  return Number(spot.upvote_count || 0) - Number(spot.downvote_count || 0);
}

function formatDistance(meters) {
  const value = Number(meters || 0);
  return value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(1)} km`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 24 * 60 * 60 * 1000) return "today";
  if (elapsed < 48 * 60 * 60 * 1000) return "yesterday";
  return date.toLocaleDateString();
}

function voteControls(spot, prefix = "") {
  const id = Number(spot.id);
  return `<div class="vote-pill-updown" aria-label="Community votes">
    <button type="button" class="vote-arrow up" data-action="vote" data-id="${id}" data-vote="upvote" aria-label="Upvote">▲</button>
    <span class="vote-count">${score(spot)}</span>
    <button type="button" class="vote-arrow down" data-action="vote" data-id="${id}" data-vote="downvote" aria-label="Downvote">▼</button>
  </div>`;
}

function statusLabel(status) {
  return status === "verified" ? "verified" : "not verified";
}

function spotCard(spot) {
  const image = spot.photo_url
    ? `<img class="spot-thumb-image" src="${escapeHtml(spot.photo_url)}" alt="">`
    : "";
  const spotName = escapeHtml(spot.name || spot.type);
  return `<article class="spot-card-row" data-spot-card="${Number(spot.id)}">
    <button type="button" class="card-thumb-box" data-action="focus-spot" data-id="${Number(spot.id)}" aria-label="Show ${spotName} on map">
      ${image}<span class="dist-badge">${escapeHtml(formatDistance(spot.distance_meters))}</span>
    </button>
    <div class="card-info">
      <div class="info-line-1">${escapeHtml(spot.type)}</div>
      <button type="button" class="info-title" data-action="details" data-id="${Number(spot.id)}" style="padding:0;border:0;background:transparent;text-align:left;cursor:pointer">${spotName}</button>
      <div class="tags-row"><span class="${spot.status === "verified" ? "badge-verified" : "badge-not-verified"}">${statusLabel(spot.status)}</span><span class="badge-date">${escapeHtml(formatDate(spot.created_at))}</span></div>
      <span class="badge-type">${escapeHtml(spot.availability || "idk")}</span>
      <div class="card-bottom-bar">
        ${voteControls(spot)}
        <button type="button" class="comment-pill" data-action="comments" data-id="${Number(spot.id)}" aria-label="Comments"><span>▤</span><span>${Number(spot.comment_count || 0)}</span></button>
        <button type="button" class="btn-edit-sm" data-action="edit" data-id="${Number(spot.id)}">edit</button>
        <button type="button" class="btn-report" data-action="flag" data-id="${Number(spot.id)}">report</button>
      </div>
    </div>
  </article>`;
}

function filteredSortedSpots() {
  const result = [...state.spots];
  if (state.sort === "best") result.sort((a, b) => Number(b.trust_score) - Number(a.trust_score));
  else if (state.sort === "commended") result.sort((a, b) => Number(b.upvote_count) - Number(a.upvote_count));
  else if (state.sort === "newest") result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  else result.sort((a, b) => Number(a.distance_meters) - Number(b.distance_meters));
  return result;
}

function renderNearby() {
  const container = $("#nearest-list-container");
  const spots = filteredSortedSpots();
  container.innerHTML = spots.length
    ? spots.map(spotCard).join("")
    : `<div class="empty-state">No spots in this area yet. Tap the map to pass one on.</div>`;
}

function renderSpotCount() {
  const count = state.totalSpotCount;
  $("#spot-count-badge").textContent = Number.isInteger(count) ? `spot ${count}` : "spot —";
}

async function loadTotalSpotCount() {
  try {
    const result = await api("/api/stats");
    state.totalSpotCount = Number(result.totalSpots);
    renderSpotCount();
  } catch {
    // Keep the existing badge value if the stats request is temporarily unavailable.
  }
}

async function loadNearby() {
  const radius = Math.round(state.radiusKm * 1000);
  const query = new URLSearchParams({
    lat: String(state.currentLocation.lat),
    lng: String(state.currentLocation.lng),
    radius: String(radius),
    filter: state.mapFilter,
  });
  try {
    const result = await api(`/api/spots/nearby?${query}`);
    state.spots = result.spots || [];
    renderNearby();
  } catch (error) {
    state.spots = [];
    renderNearby();
    showToast(`Could not load spots: ${error.message}`);
  }
}

function makeIcon(type, status) {
  const canvas = document.createElement("canvas");
  canvas.width = 44;
  canvas.height = 44;
  const ctx = canvas.getContext("2d");
  const fill = status === "verified" ? "#e2ebdd" : "#f0f1ee";
  const border = status === "verified" ? "#b8cbb1" : "#c9cec7";
  ctx.fillStyle = fill;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(5, 5, 34, 34);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#303830";
  ctx.fillStyle = "#303830";
  ctx.lineWidth = 2.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (type === "chai kada") {
    ctx.beginPath();
    ctx.moveTo(13, 18); ctx.lineTo(29, 18); ctx.lineTo(27, 29); ctx.lineTo(15, 29); ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(30, 21, 3.2, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(17, 14); ctx.lineTo(17, 11); ctx.moveTo(22, 14); ctx.lineTo(22, 10); ctx.moveTo(27, 14); ctx.lineTo(27, 12);
    ctx.stroke();
  } else if (type === "shop") {
    ctx.beginPath();
    ctx.moveTo(12, 19); ctx.lineTo(15, 12); ctx.lineTo(29, 12); ctx.lineTo(32, 19);
    ctx.moveTo(14, 19); ctx.lineTo(14, 31); ctx.lineTo(30, 31); ctx.lineTo(30, 19);
    ctx.moveTo(20, 31); ctx.lineTo(20, 23); ctx.lineTo(25, 23); ctx.lineTo(25, 31);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(29, 13, 3, 0, Math.PI * 2);
    ctx.moveTo(11, 31); ctx.lineTo(20, 20); ctx.lineTo(24, 25); ctx.lineTo(29, 18); ctx.lineTo(35, 31); ctx.closePath();
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function registerIcons(map) {
  for (const type of ["chai kada", "scenic pause", "shop"]) {
    for (const status of ["verified", "unverified"]) {
      const name = `spot-${type}-${status}`;
      if (!map.hasImage(name)) map.addImage(name, makeIcon(type, status), { pixelRatio: 2 });
    }
  }
}

function addSpotLayers() {
  const map = state.map;
  if (map.getLayer("spot-pins")) map.removeLayer("spot-pins");
  if (map.getSource("spots")) map.removeSource("spots");
  const tileTemplate = `${window.location.origin}/tiles/spots/{z}/{x}/{y}.pbf?v=${state.mvtVersion}`;
  map.addSource("spots", {
    type: "vector",
    promoteId: "id",
    tiles: [tileTemplate],
    minzoom: 0,
    maxzoom: 22,
  });
  map.addLayer({
    id: "spot-pins",
    type: "symbol",
    source: "spots",
    "source-layer": "spots",
    filter: ["!=", ["get", "status"], "hidden"],
    layout: {
      "icon-image": ["concat", "spot-", ["get", "type"], "-", ["get", "status"]],
      "icon-size": 1.15,
      "icon-anchor": "center",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      visibility: "visible",
    },
  });
  applyMapFilter();
}

function applyMapFilter() {
  const map = state.map;
  if (!map || !map.getLayer("spot-pins")) return;
  const filter = state.mapFilter === "verified"
    ? ["==", ["get", "status"], "verified"]
    : state.mapFilter === "not-verified"
      ? ["==", ["get", "status"], "unverified"]
      : ["!=", ["get", "status"], "hidden"];
  map.setFilter("spot-pins", filter);
  const zoom = map.getZoom();
  map.setLayoutProperty("spot-pins", "visibility", zoom < 9 ? "none" : "visible");
  updateClusterVisibility();
}

function updateClusterVisibility() {
  const map = state.map;
  if (!map || !map.getLayer("spot-clusters")) return;
  const clustered = map.getZoom() < 9;
  map.setLayoutProperty("spot-clusters", "visibility", clustered ? "visible" : "none");
  if (map.getLayer("spot-cluster-count")) map.setLayoutProperty("spot-cluster-count", "visibility", clustered ? "visible" : "none");
  if (clustered) scheduleClusters();
}

function scheduleClusters() {
  clearTimeout(state.clusterTimer);
  state.clusterTimer = setTimeout(updateClusters, 100);
}

function updateClusters() {
  const map = state.map;
  if (!map || !map.isStyleLoaded() || !map.getSource("spots") || map.getZoom() >= 9) return;
  let features = [];
  try { features = map.querySourceFeatures("spots", { sourceLayer: "spots" }); } catch { return; }
  const unique = new Map();
  for (const feature of features) {
    const id = feature.properties?.id ?? feature.id;
    const coords = feature.geometry?.coordinates;
    if (id == null || !Array.isArray(coords) || unique.has(String(id))) continue;
    if (state.mapFilter === "verified" && feature.properties?.status !== "verified") continue;
    if (state.mapFilter === "not-verified" && feature.properties?.status !== "unverified") continue;
    unique.set(String(id), { id, coordinates: coords });
  }
  const bins = new Map();
  for (const spot of unique.values()) {
    const point = map.project(spot.coordinates);
    const x = Math.floor(point.x / 64);
    const y = Math.floor(point.y / 64);
    const key = `${x}:${y}`;
    const bin = bins.get(key) || { x: 0, y: 0, count: 0 };
    bin.x += spot.coordinates[0];
    bin.y += spot.coordinates[1];
    bin.count += 1;
    bins.set(key, bin);
  }
  const data = {
    type: "FeatureCollection",
    features: [...bins.values()].map((bin) => ({
      type: "Feature",
      properties: { count: bin.count },
      geometry: { type: "Point", coordinates: [bin.x / bin.count, bin.y / bin.count] },
    })),
  };
  map.getSource("spot-cluster-data")?.setData(data);
}

function mapPopup(spot) {
  const id = Number(spot.id);
  const name = escapeHtml(spot.name || spot.type);
  const image = spot.photo_url ? `<img src="${escapeHtml(spot.photo_url)}" style="width:100%;height:96px;object-fit:cover;border-radius:6px" alt="">` : "";
  return `<div class="map-popup-content">
    ${image}<div class="popup-title">${name}</div>
    <div class="popup-desc">${escapeHtml(spot.type)} · ${escapeHtml(spot.availability || "idk")}</div>
    <div class="popup-hours">${escapeHtml(spot.hours || "Hours not listed")}</div>
    ${spot.description ? `<div class="popup-desc">${escapeHtml(spot.description)}</div>` : ""}
    <div style="display:flex;align-items:center;gap:7px;margin-top:8px">
      ${voteControls(spot)}
      <button class="comment-pill" data-action="comments" data-id="${id}">▤ ${Number(spot.comment_count || 0)}</button>
      <button class="btn-edit-sm" data-action="details" data-id="${id}">open</button>
      <button class="btn-edit-sm" data-action="share" data-id="${id}">share</button>
    </div>
  </div>`;
}

async function openSpot(spotOrId, coordinates) {
  let spot = typeof spotOrId === "object" ? spotOrId : state.spots.find((item) => Number(item.id) === Number(spotOrId));
  if (!spot) {
    try { spot = await api(`/api/spots/${Number(spotOrId)}?clientId=${encodeURIComponent(currentDeviceId)}`); }
    catch (error) { showToast(error.message); return; }
  }
  state.selectedSpot = spot;
  state.popup?.remove();
  const lngLat = coordinates || [Number(spot.lng), Number(spot.lat)];
  state.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: "250px" })
    .setLngLat(lngLat)
    .setHTML(mapPopup(spot))
    .addTo(state.map);
}

function installClusterSource() {
  state.map.addSource("spot-cluster-data", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  state.map.addLayer({
    id: "spot-clusters",
    type: "circle",
    source: "spot-cluster-data",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 13, 20, 20],
      "circle-color": "#e8ede5",
      "circle-stroke-color": "#aab5a6",
      "circle-stroke-width": 1,
      "circle-opacity": 0.95,
    },
    layout: { visibility: "none" },
  });
  state.map.addLayer({
    id: "spot-cluster-count",
    type: "symbol",
    source: "spot-cluster-data",
    layout: {
      "text-field": ["to-string", ["get", "count"]],
      "text-size": 11,
      "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
      "text-allow-overlap": true,
      visibility: "none",
    },
    paint: { "text-color": "#303830" },
  });
}

function transformMapboxRequest(url, token = "") {
  const accessToken = String(token || "").trim();
  if (!url.startsWith("mapbox://")) {
    // Mapbox's legacy TileJSON response may contain HTTP tile templates.
    // Upgrade those before the browser blocks them as mixed content.
    try {
      const parsedUrl = new URL(url, window.location.origin);
      const isMapboxHttpResource =
        parsedUrl.protocol === "http:" &&
        (parsedUrl.hostname === "api.mapbox.com" || /^(?:[a-d]\.)?tiles\.mapbox\.com$/i.test(parsedUrl.hostname));
      if (isMapboxHttpResource) {
        parsedUrl.protocol = "https:";
        if (accessToken && parsedUrl.hostname === "api.mapbox.com" && !parsedUrl.searchParams.has("access_token")) {
          parsedUrl.searchParams.set("access_token", accessToken);
        }
        return { url: parsedUrl.toString() };
      }
    } catch {
      // Keep non-URL values unchanged; MapLibre handles them as before.
    }
    if (accessToken && url.startsWith("https://api.mapbox.com/") && !url.includes("access_token=")) {
      return { url: `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}` };
    }
    return { url };
  }

  const resource = url.slice("mapbox://".length);
  let apiUrl;
  if (resource.startsWith("sprites/")) {
    const sprite = resource.match(/^sprites\/([^/]+)\/(.+?)(@2x)?\.(json|png)$/);
    if (!sprite) return { url };
    const [, owner, styleId, scale = "", extension] = sprite;
    apiUrl = `https://api.mapbox.com/styles/v1/${owner}/${styleId}/sprite${scale}.${extension}`;
  } else if (resource.startsWith("fonts/")) {
    apiUrl = `https://api.mapbox.com/fonts/v1/${resource.slice("fonts/".length)}`;
  } else if (resource.startsWith("styles/")) {
    apiUrl = `https://api.mapbox.com/styles/v1/${resource.slice("styles/".length)}`;
  } else {
    const tileJsonPath = resource.endsWith(".json") ? resource : `${resource}.json`;
    // Without `secure`, Mapbox TileJSON can return http:// tile templates.
    apiUrl = `https://api.mapbox.com/v4/${tileJsonPath}?secure`;
  }

  return {
    url: `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`,
  };
}

async function initMap() {
  const config = await api("/api/config").catch(() => ({ mapStyle: "https://tiles.openfreemap.org/styles/positron" }));
  let mapStyle = config.mapStyle;
  if (typeof mapStyle === "string" && mapStyle.includes("api.mapbox.com/styles/")) {
    try {
      const response = await fetch(mapStyle);
      if (!response.ok) throw new Error(`Map style request failed (${response.status})`);
      mapStyle = await response.json();
      // Mapbox styles use projection.name; MapLibre's style spec uses projection.type.
      if (mapStyle.projection?.name && !mapStyle.projection?.type) {
        mapStyle.projection.type = mapStyle.projection.name;
        delete mapStyle.projection.name;
      }
    } catch (error) {
      console.warn("Could not load the configured Mapbox style; using the light fallback.", error);
      mapStyle = "https://tiles.openfreemap.org/styles/positron";
    }
  }
  state.map = new maplibregl.Map({
    container: "map",
    style: mapStyle,
    center: [mapStart.lng, mapStart.lat],
    zoom: 13,
    minZoom: 2,
    maxZoom: 20,
    attributionControl: true,
    cooperativeGestures: true,
    transformRequest: (url) => transformMapboxRequest(url, config.mapboxToken),
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  state.map.on("load", () => {
    registerIcons(state.map);
    installClusterSource();
    addSpotLayers();
    scheduleClusters();
  });
  state.map.on("moveend", () => {
    updateClusterVisibility();
    scheduleClusters();
  });
  state.map.on("sourcedata", (event) => {
    if (event.sourceId === "spots" && event.isSourceLoaded) scheduleClusters();
  });
  state.map.on("click", "spot-pins", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties || {};
    openSpot({ ...props, id: props.id || feature.id, lng: event.lngLat.lng, lat: event.lngLat.lat }, [event.lngLat.lng, event.lngLat.lat]);
  });
  state.map.on("click", "spot-clusters", (event) => {
    const feature = state.map.queryRenderedFeatures(event.point, { layers: ["spot-clusters"] })[0];
    if (!feature) return;
    const coordinates = feature.geometry.coordinates;
    state.map.easeTo({ center: coordinates, zoom: Math.min(10, state.map.getZoom() + 2) });
  });
  state.map.on("mouseenter", "spot-pins", () => { state.map.getCanvas().style.cursor = "pointer"; });
  state.map.on("mouseleave", "spot-pins", () => { state.map.getCanvas().style.cursor = ""; });
  state.map.on("click", (event) => {
    if (state.map.queryRenderedFeatures(event.point, { layers: ["spot-pins", "spot-clusters"] }).length) return;
    state.pendingLocation = { lat: event.lngLat.lat, lng: event.lngLat.lng };
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ closeButton: false, offset: 12, closeOnClick: false })
      .setLngLat(event.lngLat)
      .setHTML(`<button class="add-pin-prompt" data-action="new-spot"><span>new spot</span><span aria-hidden="true" style="font-size:16px;font-weight:bold;background:#e8ede5;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%">+</span></button>`)
      .addTo(state.map);
  });
  state.map.on("error", (event) => {
    if (event.error) console.warn("Map resource error", event.error.message);
  });
}

function refreshMapTiles() {
  if (!state.map || !state.map.isStyleLoaded()) return;
  state.mvtVersion = Date.now();
  addSpotLayers();
  scheduleClusters();
}

function filterMap(type, clickedButton) {
  state.mapFilter = type;
  document.querySelectorAll(".filter-pills .pill").forEach((button) => button.classList.remove("active"));
  clickedButton?.classList.add("active");
  applyMapFilter();
  void loadNearby();
}

function switchView(screenId) {
  const backdrop = $("#form-backdrop");
  if (screenId === "screen2") {
    $("#screen1").classList.add("active");
    $("#screen2").classList.add("active");
    backdrop.style.display = "block";
    setTimeout(() => state.map?.resize(), 100);
  } else {
    document.querySelectorAll(".view-screen").forEach((screen) => screen.classList.remove("active"));
    $(`#${screenId}`)?.classList.add("active");
    backdrop.style.display = "none";
    if (screenId === "screen1") setTimeout(() => state.map?.resize(), 100);
  }
  $("#app-header").style.display = "flex";
}

function openAddFormFromMap() {
  state.popup?.remove();
  resetForm();
  switchView("screen2");
}

function resetForm() {
  $("#form-name").value = "";
  $("#form-description").value = "";
  $("#form-error").textContent = "";
  $("#photo-name").textContent = "";
  $("#photo-input").value = "";
  state.photoUrl = "";
  document.querySelectorAll("#spot-kind-tags .tag-btn").forEach((button, index) => button.classList.toggle("selected", index === 0));
  document.querySelectorAll("#cig-avail-tags .tag-btn").forEach((button, index) => button.classList.toggle("selected", index === 0));
}

function toggleTag(button) {
  button.parentElement.querySelectorAll(".tag-btn").forEach((tag) => tag.classList.remove("selected"));
  button.classList.add("selected");
}

function updateHoursDisplay() {
  const open = $("#open-time").value || "";
  const close = $("#close-time").value || "";
  $("#hours-summary").textContent = `${open} to ${close}`;
}

async function uploadSelectedPhoto() {
  const file = $("#photo-input").files?.[0];
  if (!file) return "";
  const body = new FormData();
  body.append("file", file);
  const result = await api("/api/uploads", { method: "POST", body });
  return result.photoUrl;
}

async function submitNewSpot() {
  const button = $("#save-spot-button");
  setModalBusy(button, true);
  $("#form-error").textContent = "";
  try {
    const kind = $("#spot-kind-tags .selected")?.textContent.trim() || "chai kada";
    const availability = $("#cig-avail-tags .selected")?.textContent.trim() || "idk";
    state.photoUrl = await uploadSelectedPhoto();
    const spot = await api("/api/spots", {
      method: "POST",
      body: JSON.stringify({
        name: $("#form-name").value.trim() || kind,
        type: kind,
        availability,
        hours: `${$("#open-time").value} to ${$("#close-time").value}`,
        description: $("#form-description").value.trim(),
        photoUrl: state.photoUrl,
        lat: state.pendingLocation?.lat ?? state.currentLocation.lat,
        lng: state.pendingLocation?.lng ?? state.currentLocation.lng,
      }),
    });
    switchView("screen1");
    state.currentLocation = { lat: Number(spot.lat), lng: Number(spot.lng) };
    state.map?.flyTo({ center: [spot.lng, spot.lat], zoom: Math.max(15, state.map.getZoom()) });
    await Promise.all([loadNearby(), loadTotalSpotCount(), new Promise((resolve) => setTimeout(resolve, 250))]);
    refreshMapTiles();
    showToast("Spot added. Community verification starts now.");
  } catch (error) {
    $("#form-error").textContent = error.message;
    showToast(error.message);
  } finally {
    setModalBusy(button, false, "SAVE SPOT");
  }
}

async function voteSpot(id, action) {
  try {
    const outcome = await api(`/api/spots/${Number(id)}/interactions`, {
      method: "POST",
      body: JSON.stringify({ clientId: currentDeviceId, action }),
    });
    const listSpot = state.spots.find((spot) => Number(spot.id) === Number(id));
    if (listSpot) Object.assign(listSpot, outcome);
    if (state.selectedSpot && Number(state.selectedSpot.id) === Number(id)) Object.assign(state.selectedSpot, outcome);
    renderNearby();
    refreshMapTiles();
    if (outcome.status === "verified") showToast("Community verified this spot.");
    else if (outcome.status === "hidden") showToast("This spot was hidden after community feedback.");
    else showToast(action === "flag" ? "Thanks. Your report was counted." : "Your vote was counted.");
    if (state.popup && state.selectedSpot?.id == id) state.popup.setHTML(mapPopup(state.selectedSpot));
    await Promise.all([loadNearby(), loadTotalSpotCount()]);
  } catch (error) { showToast(error.message); }
}

async function openComments(id) {
  const spot = state.spots.find((item) => Number(item.id) === Number(id)) || state.selectedSpot;
  showDialog(`comments · ${spot?.name || "spot"}`, `<div id="comment-list"><div class="empty-state">Loading comments…</div></div>
    <form id="comment-form"><label class="form-label" for="comment-input">pass on a useful detail</label>
      <textarea id="comment-input" class="form-input spot-description" maxlength="300" required placeholder="Up to 300 characters"></textarea>
      <div class="dialog-row"><button type="submit">post comment</button><span class="form-label">3 comments per 15 minutes</span></div>
      <div class="form-error" id="comment-error"></div>
    </form>`);
  const renderComments = async () => {
    try {
      const result = await api(`/api/spots/${Number(id)}/comments`);
      const list = $("#comment-list");
      if (!list) return;
      list.innerHTML = result.comments.length
        ? result.comments.map((comment) => `<div class="dialog-entry">${escapeHtml(comment.content)}<small>${escapeHtml(comment.display_name || "Local friend")} · ${escapeHtml(formatDate(comment.created_at))}</small></div>`).join("")
        : `<div class="empty-state">No comments yet.</div>`;
    } catch (error) { if ($("#comment-list")) $("#comment-list").innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`; }
  };
  await renderComments();
  $("#comment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    setModalBusy(button, true, "posting…");
    try {
      const content = $("#comment-input").value.trim();
      await api(`/api/spots/${Number(id)}/comments`, { method: "POST", body: JSON.stringify({ content, clientId: currentDeviceId }) });
      $("#comment-input").value = "";
      await renderComments();
      await loadNearby();
      showToast("Comment posted.");
    } catch (error) { $("#comment-error").textContent = error.message; }
    finally { setModalBusy(button, false); }
  });
}

async function openEditProposal(id) {
  const spot = state.spots.find((item) => Number(item.id) === Number(id)) || state.selectedSpot;
  if (!spot) return;
  showDialog("suggest an edit", `<p class="form-label">Changes are applied after 3 different community members vote for them.</p>
    <form id="edit-form">
      <label class="form-label" for="edit-name">name</label><input id="edit-name" class="form-input" maxlength="100" value="${escapeHtml(spot.name)}">
      <label class="form-label" for="edit-type">kind of spot</label><select id="edit-type" class="form-input">
        ${["chai kada", "scenic pause", "shop"].map((type) => `<option ${spot.type === type ? "selected" : ""}>${type}</option>`).join("")}
      </select>
      <label class="form-label" for="edit-availability">availability</label><select id="edit-availability" class="form-input">
        ${["imported only", "local only", "idk"].map((value) => `<option ${spot.availability === value ? "selected" : ""}>${value}</option>`).join("")}
      </select>
      <label class="form-label" for="edit-hours">opening hours</label><input id="edit-hours" class="form-input" maxlength="100" value="${escapeHtml(spot.hours || "")}">
      <label class="form-label" for="edit-description">description</label><textarea id="edit-description" class="form-input spot-description" maxlength="300">${escapeHtml(spot.description || "")}</textarea>
      <div class="dialog-row"><label class="form-label" for="edit-lat">latitude</label><input id="edit-lat" class="form-input" type="number" step="any" value="${Number(spot.lat)}">
      <label class="form-label" for="edit-lng">longitude</label><input id="edit-lng" class="form-input" type="number" step="any" value="${Number(spot.lng)}"></div>
      <div class="dialog-row"><button type="submit">send suggestion</button></div><div class="form-error" id="edit-error"></div>
    </form><h3 style="font-size:14px;margin-top:8px">community suggestions</h3><div id="proposal-list"><div class="empty-state">Loading…</div></div>`);
  const loadProposals = async () => {
    const result = await api(`/api/spots/${Number(id)}/edit-proposals`);
    const list = $("#proposal-list");
    if (!list) return;
    list.innerHTML = result.proposals.length ? result.proposals.map((proposal) => {
      const data = proposal.proposed_data || {};
      const description = [data.name && `name: ${data.name}`, data.description && `description: ${data.description}`].filter(Boolean).join(" · ");
      return `<div class="dialog-entry"><strong>${escapeHtml(description || "Suggested update")}</strong><small>${Number(proposal.vote_count)} of 3 votes · ${escapeHtml(proposal.status)}</small>
        ${proposal.status === "pending" ? `<div class="proposal-actions"><button data-action="proposal-vote" data-id="${Number(proposal.id)}">support edit</button></div>` : ""}</div>`;
    }).join("") : `<div class="empty-state">No edit suggestions yet.</div>`;
  };
  try { await loadProposals(); } catch (error) { $("#proposal-list").innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`; }
  $("#edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    setModalBusy(button, true, "sending…");
    try {
      await api(`/api/spots/${Number(id)}/edit-proposals`, {
        method: "POST",
        body: JSON.stringify({
          clientId: currentDeviceId,
          name: $("#edit-name").value.trim(),
          type: $("#edit-type").value,
          availability: $("#edit-availability").value,
          hours: $("#edit-hours").value.trim(),
          description: $("#edit-description").value.trim(),
          lat: Number($("#edit-lat").value),
          lng: Number($("#edit-lng").value),
        }),
      });
      await loadProposals();
      showToast("Edit suggestion submitted.");
    } catch (error) { $("#edit-error").textContent = error.message; }
    finally { setModalBusy(button, false); }
  });
  $("#proposal-list")?.addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="proposal-vote"]');
    if (!button) return;
    setModalBusy(button, true, "counting…");
    try {
      const outcome = await api(`/api/edit-proposals/${Number(button.dataset.id)}/votes`, { method: "POST", body: JSON.stringify({ clientId: currentDeviceId }) });
      await loadProposals();
      if (outcome.status === "merged") { refreshMapTiles(); await loadNearby(); showToast("Community edit applied."); }
      else showToast(`${outcome.vote_count} of 3 community votes.`);
    } catch (error) { showToast(error.message); }
  });
}

async function focusSpot(id) {
  let spot = state.spots.find((item) => Number(item.id) === Number(id));
  if (!spot) {
    try { spot = await api(`/api/spots/${Number(id)}?clientId=${encodeURIComponent(currentDeviceId)}`); }
    catch (error) { showToast(error.message); return; }
  }
  state.map.flyTo({ center: [Number(spot.lng), Number(spot.lat)], zoom: Math.max(15, state.map.getZoom()) });
  await openSpot(spot, [Number(spot.lng), Number(spot.lat)]);
}

function mapsLinkForSpot(spot) {
  const lat = Number(spot.lat);
  const lng = Number(spot.lng);
  const name = String(spot.name || spot.type || "Cigspot");
  const isAppleDevice = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isAppleDevice) {
    return {
      app: "Apple Maps",
      url: `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(name)}`,
    };
  }
  return {
    app: "Google Maps",
    url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
  };
}

async function shareSpot(id) {
  let spot = state.spots.find((item) => Number(item.id) === Number(id)) || state.selectedSpot;
  if (
    !spot
    || Number(spot.id) !== Number(id)
    || !Number.isFinite(Number(spot.lat))
    || !Number.isFinite(Number(spot.lng))
  ) {
    try { spot = await api(`/api/spots/${Number(id)}?clientId=${encodeURIComponent(currentDeviceId)}`); }
    catch (error) { showToast(error.message); return; }
  }
  const lat = Number(spot.lat);
  const lng = Number(spot.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return showToast("This spot has no map location to share.");
  const mapLink = mapsLinkForSpot(spot);
  const name = String(spot.name || spot.type || "Cigspot");
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text: `Find ${name} on ${mapLink.app}`, url: mapLink.url });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(mapLink.url);
    showToast(`${mapLink.app} link copied.`);
  } catch {
    window.prompt(`Copy this ${mapLink.app} link`, mapLink.url);
  }
}

function showCurrentLocationMarker(location) {
  if (!state.map) return;
  if (!state.currentLocationMarker) {
    const element = document.createElement("div");
    element.className = "current-location-marker";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", "Your current location");
    element.title = "Your current location";
    state.currentLocationMarker = new maplibregl.Marker({ element, anchor: "center" });
  }
  state.currentLocationMarker
    .setLngLat([location.lng, location.lat])
    .addTo(state.map);
}

async function triggerFindNearMe() {
  if (!navigator.geolocation) return showToast("Location is not available in this browser.");
  const button = $(".btn-find-near");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "finding you…";
  navigator.geolocation.getCurrentPosition(async (position) => {
    state.currentLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
    showCurrentLocationMarker(state.currentLocation);
    state.map?.flyTo({ center: [state.currentLocation.lng, state.currentLocation.lat], zoom: 15 });
    await loadNearby();
    $("#nearest-to-you-section").scrollIntoView({ behavior: "smooth", block: "start" });
    button.disabled = false;
    button.textContent = original;
  }, (error) => {
    button.disabled = false;
    button.textContent = original;
    showToast(error.code === 1 ? "Allow location access to find nearby spots." : "Could not get your location.");
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

function adjustRadius(delta) {
  state.radiusKm = Math.max(0.5, Math.min(50, state.radiusKm + delta));
  $("#radius-val").textContent = `${state.radiusKm % 1 ? state.radiusKm.toFixed(1) : state.radiusKm}km radius`;
  void loadNearby();
}

function sortBy(value, button) {
  state.sort = value;
  document.querySelectorAll("#sort-controls .sort-chip").forEach((chip) => chip.classList.remove("active"));
  button.classList.add("active");
  renderNearby();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "new-spot") openAddFormFromMap();
  else if (action === "vote") { event.preventDefault(); event.stopPropagation(); void voteSpot(id, button.dataset.vote); }
  else if (action === "comments") { event.preventDefault(); void openComments(id); }
  else if (action === "share") { event.preventDefault(); void shareSpot(id); }
  else if (action === "edit") { event.preventDefault(); void openEditProposal(id); }
  else if (action === "details") { event.preventDefault(); void focusSpot(id); }
  else if (action === "focus-spot") { event.preventDefault(); void focusSpot(id); }
  else if (action === "flag") { event.preventDefault(); void voteSpot(id, "flag"); }
});

$("#dialog-close").addEventListener("click", closeDialog);
$("#content-dialog").addEventListener("click", (event) => { if (event.target.id === "content-dialog") closeDialog(); });
$("#photo-button").addEventListener("click", () => $("#photo-input").click());
$("#photo-input").addEventListener("change", () => {
  const file = $("#photo-input").files?.[0];
  $("#photo-name").textContent = file ? file.name : "";
});
$("#save-spot-button").addEventListener("click", () => void submitNewSpot());
$("#sort-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort]");
  if (button) sortBy(button.dataset.sort, button);
});
document.querySelectorAll(".filter-pills .pill").forEach((button) => {
  button.addEventListener("click", () => filterMap(button.textContent.trim().toLowerCase().replace(" ", "-"), button));
});
document.querySelectorAll("#spot-kind-tags .tag-btn, #cig-avail-tags .tag-btn").forEach((button) => button.addEventListener("click", () => toggleTag(button)));
$("#open-time").addEventListener("change", updateHoursDisplay);
$("#close-time").addEventListener("change", updateHoursDisplay);

Object.assign(globalThis, {
  switchView,
  filterMap: (type) => filterMap(type),
  openAddFormFromMap,
  toggleTag,
  updateHoursDisplay,
  triggerFindNearMe,
  adjustRadius,
});

await initMap();
await Promise.all([loadNearby(), loadTotalSpotCount()]);
setInterval(loadTotalSpotCount, 60_000);
