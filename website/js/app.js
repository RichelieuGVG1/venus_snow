/**
 * Venus 3D Interactive Atlas — Main Application
 * ---------------------------------------------
 * Three.js WebGL engine: globe and regional relief models, real-time snow
 * shader (threshold / source / display mode), relief exaggeration,
 * isolines, snowline plane, coordinate grids, region frames on the globe,
 * a top-down map of the active region and light/dark themes.
 *
 * The behaviour mirrors the reference Plotly pages in
 * venus_snow/results/export_3d/*.html.
 *
 * Author: Vasily Guryanov
 */

import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import { OBJExporter } from './obj_exporter.js';
import { BSROverlay } from './bsr_overlay.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------
const R_KM = 6051.0;                         // Venus radius, km
const KM_PER_DEG = R_KM * Math.PI / 180;     // ≈ 105.61 km per degree
const GRAY_SCALE = 254;                      // probability = pixel / 254 (as in the reference pages)
const DEFAULT_THRESHOLD = 0.77;
const LAYER_ORDER = ['elev', 'snow_prob', 'anomaly', 'cluster', 'emis', 'eps_refl', 'refl_norm', 'slope'];
const SNOW_SOURCES = { snow_prob: 'snow_prob_gray', anomaly: 'anomaly_gray' };
const SNOW_RAMP = ['#ff2d95', '#ff8fcf', '#ffd6ef', '#ffffff'];   // p = threshold … 1
const LEVEL_COLOR = '#4fc3f7';
const EXAG_RANGES = {
    globe: { min: 0, max: 120, step: 5 },
    region: { min: 1, max: 60, step: 5 }
};

// --------------------------------------------------------------------------
// Application state
// --------------------------------------------------------------------------
const state = {
    manifest: null,
    activeObjectId: null,
    activeLayerId: 'elev',
    snowSource: 'snow_prob',
    snowThreshold: DEFAULT_THRESHOLD,
    showSnow: true,
    viewMode: 'both',            // both | relief | snow
    contours: true,
    planeOn: true,
    level: 3.8,
    showGrid: true,
    showFrames: true,
    autoRotate: true,
    bsrVisible: false,
    exag: {}                     // per object id
};

// Three.js core objects
let scene, camera, renderer, controls, headLight;
let bsrOverlay = null;
let activeGroup = null;

// Per-object cache: geometry, materials and data for statistics and the map
const objects = {};
const textureCache = {};

// Shared shader uniforms (UI controls update them directly)
const uniforms = {
    uSnowMap: { value: null },
    uThreshold: { value: DEFAULT_THRESHOLD },
    uSnowOn: { value: 1 },
    uMode: { value: 0 },
    uContours: { value: 0 },
    uPlaneOn: { value: 0 },
    uLevel: { value: 3.8 },
    uBaseExag: { value: 1 },
    uUvScale: { value: new THREE.Vector2(1, 1) },
    uUvOffset: { value: new THREE.Vector2(0, 0) },
    uSnowRamp0: { value: new THREE.Color(SNOW_RAMP[0]) },
    uSnowRamp1: { value: new THREE.Color(SNOW_RAMP[1]) },
    uSnowRamp2: { value: new THREE.Color(SNOW_RAMP[2]) },
    uSnowRamp3: { value: new THREE.Color(SNOW_RAMP[3]) },
    uLevelColor: { value: new THREE.Color(LEVEL_COLOR) }
};

const dom = {};

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
async function initApp() {
    bindDomElements();
    updateLoadingProgress('Инициализация 3D-сцены WebGL...');

    initThreeScene();
    updateLoadingProgress('Получение каталога моделей и метаданных...');

    await loadManifest();
    updateLoadingProgress('Построение интерфейса...');

    initUI();
    initEventListeners();
    animate();

    await switchModel('globe');
}

function bindDomElements() {
    const id = (x) => document.getElementById(x);
    Object.assign(dom, {
        loadingOverlay: id('loading-overlay'),
        loadingText: id('loading-text'),
        themeToggle: id('btn-theme-toggle'),

        regionPills: id('region-pills'),
        selectLayer: id('select-layer'),
        selectSnowSource: id('select-snow-source'),
        selectViewMode: id('select-view-mode'),

        sliderExag: id('slider-exag'),
        valExag: id('val-exag'),
        checkPlane: id('check-plane'),
        sliderLevel: id('slider-level'),
        valLevel: id('val-level'),

        checkShowSnow: id('check-show-snow'),
        checkContours: id('check-contours'),
        checkGrid: id('check-grid'),
        checkFrames: id('check-frames'),
        checkBsrTracks: id('check-bsr-tracks'),
        checkAutorotate: id('check-autorotate'),

        btnExportGlb: id('btn-export-glb'),
        btnExportObj: id('btn-export-obj'),
        btnSnapshot: id('btn-snapshot'),
        modalBackdrop: id('info-modal-backdrop'),
        btnOpenInfo: id('btn-open-info'),
        btnCloseModal: id('btn-close-modal'),

        legendTitle: id('legend-title'),
        legendBar: id('legend-bar'),
        legendTicks: id('legend-ticks'),
        legendCategorical: id('legend-categorical'),
        legendContinuousWrap: id('legend-continuous-wrap'),

        sliderThreshold: id('slider-snow-threshold'),
        valThreshold: id('val-snow-threshold'),
        snowScaleMin: id('snow-scale-min'),
        snowHint: id('snow-hint'),
        telemetry: id('telemetry'),

        topmapCanvas: id('topmap-canvas'),
        topmapReadout: id('topmap-readout'),
        topmapLegendSnow: id('topmap-legend-snow'),
        topmapLegendLevel: id('topmap-legend-level'),
        topmapLegendLevelRow: id('topmap-legend-level-row')
    });
}

function updateLoadingProgress(text) {
    if (dom.loadingText && text) dom.loadingText.textContent = text;
}

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

// --------------------------------------------------------------------------
// Theme (the initial value is set by the inline script in <head>)
// --------------------------------------------------------------------------
function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
        localStorage.setItem('venus-theme', next);
    } catch (e) {
        // Storage may be unavailable (private mode) — the theme still switches
    }
    applyThemeToScene();
}

function applyThemeToScene() {
    if (scene) scene.background = new THREE.Color(cssVar('--scene-bg', '#e8edf5'));
    rebuildOverlays();
    drawTopMap();
}

// --------------------------------------------------------------------------
// Three.js scene
// --------------------------------------------------------------------------
function initThreeScene() {
    const container = document.getElementById('app-viewport');
    const width = container.clientWidth;
    const height = container.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar('--scene-bg', '#e8edf5'));

    camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 5000);
    camera.position.set(2.2, 1.4, 2.8);
    scene.add(camera);

    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('canvas3d'),
        antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Data colour maps must be shown as they are, so no tone mapping
    renderer.toneMapping = THREE.NoToneMapping;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = state.autoRotate;
    controls.autoRotateSpeed = 0.5;

    // Even fill lighting: a strong ambient term plus a soft "headlight" that
    // follows the camera, so every model is lit the same from any angle while
    // the relief still reads through gentle shading.
    scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    headLight = new THREE.DirectionalLight(0xffffff, 1.2);
    headLight.position.set(0.3, 0.6, 1);
    camera.add(headLight);
    camera.add(headLight.target);
    headLight.target.position.set(0, 0, -1);

    activeGroup = new THREE.Group();
    activeGroup.name = 'active_model_group';
    scene.add(activeGroup);

    bsrOverlay = new BSROverlay(THREE, { radius: 1.008 });
    scene.add(bsrOverlay.group);

    window.addEventListener('resize', onWindowResize);
}

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------
async function loadManifest() {
    try {
        const resp = await fetch('/api/regions');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state.manifest = await resp.json();
    } catch (err) {
        console.warn('Fallback to /api/manifest...', err);
        const mResp = await fetch('/api/manifest');
        if (!mResp.ok) throw new Error(`Не удалось получить manifest: HTTP ${mResp.status}`);
        state.manifest = await mResp.json();
    }
    const snow = state.manifest.snow || {};
    if (typeof snow.default_threshold === 'number') state.snowThreshold = snow.default_threshold;
}

function getObjectMeta(id) {
    return state.manifest.objects.find((o) => o.id === id);
}

function isGlobe(meta) {
    return Boolean(meta) && (meta.type === 'globe' || meta.id === 'globe');
}

function activeObject() {
    return objects[state.activeObjectId] || null;
}

// --------------------------------------------------------------------------
// Texture & image helpers
// --------------------------------------------------------------------------
function loadTexture(url, { isData = false, nearest = false } = {}) {
    const key = `${url}|${isData ? 'data' : 'color'}|${nearest ? 'n' : 'l'}`;
    if (textureCache[key]) return textureCache[key];

    textureCache[key] = new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(
            url,
            (tex) => {
                tex.flipY = false;
                tex.colorSpace = isData ? THREE.NoColorSpace : THREE.SRGBColorSpace;
                if (nearest) {
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.generateMipmaps = false;
                }
                resolve(tex);
            },
            undefined,
            () => {
                delete textureCache[key];
                reject(new Error(`Не удалось загрузить текстуру ${url}`));
            }
        );
    });
    return textureCache[key];
}

function readImageRGBA(image) {
    const w = image.width, h = image.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** One channel of an image as a Uint8Array (row-major, top row first). */
function readImageChannel(image, channel = 0) {
    const { data, width, height } = readImageRGBA(image);
    const out = new Uint8Array(width * height);
    for (let i = 0, j = channel; i < out.length; i++, j += 4) out[i] = data[j];
    return { data: out, width, height };
}

/** 256-entry sRGB (0..255) lookup table interpolated between the manifest colour stops. */
function buildColorLUT(colors, n = 256) {
    // THREE.Color stores linear values; convert back to sRGB to compare with PNG pixels
    const stops = colors.map((c) => new THREE.Color(c).convertLinearToSRGB());
    const lut = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1) * (stops.length - 1);
        const k = Math.min(Math.floor(t), stops.length - 2);
        const f = t - k;
        const a = stops[k], b = stops[k + 1];
        lut[i * 3] = (a.r + (b.r - a.r) * f) * 255;
        lut[i * 3 + 1] = (a.g + (b.g - a.g) * f) * 255;
        lut[i * 3 + 2] = (a.b + (b.b - a.b) * f) * 255;
    }
    return lut;
}

/** Decodes a colour-mapped layer PNG back to values (nearest LUT entry). */
function decodeColorMapped(image, layerInfo) {
    const { data, width, height } = readImageRGBA(image);
    const n = width * height;
    const lut = buildColorLUT(layerInfo.colors);
    const [vmin, vmax] = layerInfo.range;
    const memo = new Map();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        const key = (r << 16) | (g << 8) | b;
        let v = memo.get(key);
        if (v === undefined) {
            let best = 0, bestD = Infinity;
            for (let j = 0; j < 256; j++) {
                const dr = lut[j * 3] - r, dg = lut[j * 3 + 1] - g, db = lut[j * 3 + 2] - b;
                const d = dr * dr + dg * dg + db * db;
                if (d < bestD) { bestD = d; best = j; }
            }
            v = vmin + best / 255 * (vmax - vmin);
            memo.set(key, v);
        }
        out[i] = v;
    }
    return out;
}

// --------------------------------------------------------------------------
// Terrain material with the snow / isoline shader
// --------------------------------------------------------------------------
function createTerrainMaterial(baseTexture) {
    // Lambert = purely diffuse: even, matte look without specular highlights
    const mat = new THREE.MeshLambertMaterial({ map: baseTexture });

    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);

        // Own varyings: three r160 only declares vUv under USE_UV
        shader.vertexShader = `
            uniform vec2 uUvScale;
            uniform vec2 uUvOffset;
            uniform float uBaseExag;
            varying vec2 vSnowUv;
            varying float vHeightKm;
        ` + shader.vertexShader.replace(
            '#include <uv_vertex>',
            `
            #include <uv_vertex>
            vSnowUv = uv * uUvScale + uUvOffset;
            vHeightKm = position.y / uBaseExag;
            `
        );

        shader.fragmentShader = `
            uniform sampler2D uSnowMap;
            uniform float uThreshold;
            uniform int uSnowOn;
            uniform int uMode;
            uniform int uContours;
            uniform int uPlaneOn;
            uniform float uLevel;
            uniform vec3 uSnowRamp0;
            uniform vec3 uSnowRamp1;
            uniform vec3 uSnowRamp2;
            uniform vec3 uSnowRamp3;
            uniform vec3 uLevelColor;
            varying vec2 vSnowUv;
            varying float vHeightKm;

            vec3 snowRamp(float t) {
                if (t < 1.0 / 3.0) return mix(uSnowRamp0, uSnowRamp1, t * 3.0);
                if (t < 2.0 / 3.0) return mix(uSnowRamp1, uSnowRamp2, t * 3.0 - 1.0);
                return mix(uSnowRamp2, uSnowRamp3, t * 3.0 - 2.0);
            }
        ` + shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            #include <map_fragment>

            float snowP = min(texture2D(uSnowMap, vSnowUv).r * (255.0 / ${GRAY_SCALE}.0), 1.0);
            bool isSnow = uSnowOn == 1 && snowP >= uThreshold;

            // "Только снег": hide everything that is not snow
            if (uMode == 2 && !isSnow) discard;

            // Snow colour ramp: pink at the threshold -> white at p = 1
            if (isSnow && uMode != 1) {
                float t = clamp((snowP - uThreshold) / max(1.0 - uThreshold, 1e-3), 0.0, 1.0);
                diffuseColor.rgb = snowRamp(t);
            }

            // Isolines every 1 km
            if (uContours == 1) {
                float w = max(fwidth(vHeightKm), 1e-5);
                float d = abs(fract(vHeightKm + 0.5) - 0.5) / w;
                float line = 1.0 - smoothstep(0.5, 1.5, d);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0), line * 0.45);
            }

            // Where the snowline plane cuts the relief
            if (uPlaneOn == 1) {
                float w2 = max(fwidth(vHeightKm), 1e-5);
                float d2 = abs(vHeightKm - uLevel) / w2;
                float line2 = 1.0 - smoothstep(0.8, 2.0, d2);
                diffuseColor.rgb = mix(diffuseColor.rgb, uLevelColor, line2 * 0.95);
            }
            `
        );
    };

    return mat;
}

// --------------------------------------------------------------------------
// Model loading
// --------------------------------------------------------------------------
async function loadObject(meta) {
    if (objects[meta.id]) return objects[meta.id];

    updateLoadingProgress(`Загрузка 3D-модели: ${meta.name}...`);
    const gltf = await new GLTFLoader().loadAsync(`/export_3d/${meta.glb}`);

    let mesh = null;
    gltf.scene.traverse((node) => {
        if (node.isMesh && !mesh) mesh = node;
    });
    if (!mesh) throw new Error('No mesh in GLB');

    const geometry = mesh.geometry;
    const globe = isGlobe(meta);

    const obj = {
        meta,
        globe,
        baseExag: meta.exaggeration || (globe ? 40 : 6),
        mesh,
        container: new THREE.Group(),
        terrainGroup: new THREE.Group(),   // scaled vertically for regions
        overlayGroup: new THREE.Group(),   // grid / frames, rebuilt on demand
        plane: null,
        basePositions: null,
        extent: null,
        nr: 0,
        nc: 0,
        rowArea: null,     // km² per cell, per grid row
        totalArea: 0,
        heights: null,     // km per grid cell (regions)
        emis: null,        // emissivity per grid cell (regions)
        snow: {},          // source -> Uint8Array
        snowTex: {},       // source -> THREE.Texture
        hist: {},          // source -> Float64Array(256): area per gray value
        layerImage: null
    };

    mesh.removeFromParent();
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.name = meta.id;

    // The GLB files have no NORMAL attribute
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    if (globe) {
        obj.basePositions = geometry.attributes.position.array.slice();
    } else {
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        obj.extent = {
            halfX: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
            halfZ: Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z))
        };

        // Snowline plane; lives in the scaled group, so y = level × base exaggeration
        const planeGeo = new THREE.PlaneGeometry(obj.extent.halfX * 2, obj.extent.halfZ * 2);
        planeGeo.rotateX(-Math.PI / 2);
        obj.plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
            color: LEVEL_COLOR,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false
        }));
        obj.plane.renderOrder = 2;
        obj.terrainGroup.add(obj.plane);
    }

    obj.terrainGroup.add(mesh);
    obj.container.add(obj.terrainGroup);
    obj.container.add(obj.overlayGroup);

    const tex = await loadLayerTexture(meta, state.activeLayerId);
    mesh.material = createTerrainMaterial(tex);
    obj.layerImage = tex.image;

    updateLoadingProgress(`Подготовка данных: ${meta.name}...`);
    await prepareObjectData(obj);

    objects[meta.id] = obj;
    return obj;
}

async function loadLayerTexture(meta, layerId) {
    const textures = meta.textures || {};
    const rel = textures[layerId] || textures.elev;
    const tex = await loadTexture(`/export_3d/${rel}`, { nearest: layerId === 'cluster' });
    if (!isGlobe(meta)) applyPixelCenterUv(tex);
    return tex;
}

/**
 * Region meshes put UV 0 and 1 on the first and last vertex, while a texture
 * pixel's centre is at (i + 0.5) / n. Shift the texture so each vertex samples
 * the centre of its own pixel.
 */
function applyPixelCenterUv(tex) {
    const w = tex.image.width, h = tex.image.height;
    tex.repeat.set((w - 1) / w, (h - 1) / h);
    tex.offset.set(0.5 / w, 0.5 / h);
}

async function prepareObjectData(obj) {
    const { meta, globe } = obj;

    // Snow sources: gray PNGs, probability = pixel / 254
    for (const [src, texKey] of Object.entries(SNOW_SOURCES)) {
        const rel = meta.textures && meta.textures[texKey];
        if (!rel) continue;
        const tex = await loadTexture(`/export_3d/${rel}`, { isData: true });
        const { data, width, height } = readImageChannel(tex.image, 0);
        obj.snow[src] = data;
        obj.snowTex[src] = tex;
        obj.nr = height;
        obj.nc = width;
    }

    const nr = obj.nr, nc = obj.nc;
    if (!nr || !nc) return;

    const rowArea = new Float32Array(nr);
    if (globe) {
        const dLat = 180 / nr, dLon = 360 / nc;
        for (let r = 0; r < nr; r++) {
            const lat = 90 - (r + 0.5) * dLat;
            rowArea[r] = (dLat * KM_PER_DEG) * (dLon * KM_PER_DEG * Math.cos(lat * Math.PI / 180));
        }
    } else {
        const { lat, lon } = meta.bounds;
        const dLat = (lat[1] - lat[0]) / (nr - 1);
        const dLon = (lon[1] - lon[0]) / (nc - 1);
        for (let r = 0; r < nr; r++) {
            const la = lat[1] - r * dLat;
            rowArea[r] = (dLat * KM_PER_DEG) * (dLon * KM_PER_DEG * Math.cos(la * Math.PI / 180));
        }
    }
    obj.rowArea = rowArea;
    obj.totalArea = rowArea.reduce((s, a) => s + a * nc, 0);

    // Area histogram per gray value → snow area for any threshold in O(256)
    for (const [src, data] of Object.entries(obj.snow)) {
        const hist = new Float64Array(256);
        for (let r = 0; r < nr; r++) {
            const a = rowArea[r];
            const base = r * nc;
            for (let c = 0; c < nc; c++) hist[data[base + c]] += a;
        }
        obj.hist[src] = hist;
    }

    if (!globe) {
        // Heights come straight from the mesh: vertex i = row × nc + col (row 0 = north)
        const pos = obj.mesh.geometry.attributes.position;
        if (pos.count === nr * nc) {
            obj.heights = new Float32Array(pos.count);
            for (let i = 0; i < pos.count; i++) obj.heights[i] = pos.getY(i) / obj.baseExag;
        } else {
            console.warn(`Сетка ${meta.id} не совпадает с текстурой: ${pos.count} ≠ ${nr}×${nc}`);
        }

        // Emissivity for the "above / below the plane" statistic
        const emisInfo = state.manifest.layers && state.manifest.layers.emis;
        if (emisInfo && meta.textures.emis) {
            const tex = await loadTexture(`/export_3d/${meta.textures.emis}`);
            if (tex.image.width === nc && tex.image.height === nr) {
                obj.emis = decodeColorMapped(tex.image, emisInfo);
            }
        }
    }
}

function snowAreaFor(obj, src, thr) {
    const hist = obj.hist[src];
    if (!hist) return 0;
    const from = Math.max(0, Math.ceil(thr * GRAY_SCALE - 1e-6));
    let sum = 0;
    for (let v = from; v < 256; v++) sum += hist[v];
    return sum;
}

// --------------------------------------------------------------------------
// Switching objects and layers
// --------------------------------------------------------------------------
async function switchModel(objectId) {
    const meta = getObjectMeta(objectId);
    if (!meta) return;

    dom.loadingOverlay.classList.remove('hidden');
    try {
        const obj = await loadObject(meta);

        state.activeObjectId = objectId;
        while (activeGroup.children.length) activeGroup.remove(activeGroup.children[0]);
        activeGroup.add(obj.container);

        await setObjectLayer(obj, state.activeLayerId);

        document.body.classList.toggle('scope-globe', obj.globe);
        document.body.classList.toggle('scope-region', !obj.globe);

        const range = obj.globe ? EXAG_RANGES.globe : EXAG_RANGES.region;
        dom.sliderExag.min = range.min;
        dom.sliderExag.max = range.max;
        dom.sliderExag.step = range.step;
        if (state.exag[objectId] === undefined) state.exag[objectId] = obj.baseExag;
        dom.sliderExag.value = state.exag[objectId];

        // Default plane level = the region's snowline h_c
        if (!obj.globe) {
            state.level = Math.round((meta.snowline_km ?? 3.5) * 10) / 10;
            dom.sliderLevel.value = state.level;
        }

        applyExaggeration();

        if (bsrOverlay) {
            if (obj.globe && !bsrOverlay.tracksData) await bsrOverlay.load();
            if (obj.globe) bsrOverlay.setSurfaceFunction((la, lo) => globeSurfaceRadius(obj, la, lo));
            bsrOverlay.setVisible(obj.globe && state.bsrVisible);
        }

        syncUniforms();
        rebuildOverlays();
        fitCameraToObject(obj);
        updateActivePills();
        updateLegend();
        updateTelemetry();
        drawTopMap();
    } catch (err) {
        console.error('Error loading model:', err);
        alert(`Не удалось загрузить модель: ${err.message}`);
    } finally {
        dom.loadingOverlay.classList.add('hidden');
    }
}

async function setObjectLayer(obj, layerId) {
    const tex = await loadLayerTexture(obj.meta, layerId);
    const mat = obj.mesh.material;
    if (mat.map !== tex) {
        mat.map = tex;
        mat.needsUpdate = true;
    }
    obj.layerImage = tex.image;
}

async function applyLayer(layerId) {
    state.activeLayerId = layerId;
    const obj = activeObject();
    if (obj) await setObjectLayer(obj, layerId);
    syncUniforms();
    updateLegend();
    drawTopMap();
}

/** Pushes UI state into the shader uniforms and helper objects. */
function syncUniforms() {
    const obj = activeObject();
    if (!obj) return;

    // As in the reference pages, the snow overlay is not drawn over the snow
    // layers themselves (it would hide what they show)
    const layerIsSnow = state.activeLayerId === 'snow_prob' || state.activeLayerId === 'anomaly';

    uniforms.uSnowMap.value = obj.snowTex[state.snowSource] || null;
    uniforms.uThreshold.value = state.snowThreshold;
    uniforms.uSnowOn.value = state.showSnow && !layerIsSnow && uniforms.uSnowMap.value ? 1 : 0;
    uniforms.uMode.value = { both: 0, relief: 1, snow: 2 }[state.viewMode] ?? 0;
    uniforms.uContours.value = !obj.globe && state.contours ? 1 : 0;
    uniforms.uPlaneOn.value = !obj.globe && state.planeOn ? 1 : 0;
    uniforms.uLevel.value = state.level;
    uniforms.uBaseExag.value = obj.globe ? 1 : obj.baseExag;

    if (obj.globe) {
        uniforms.uUvScale.value.set(1, 1);
        uniforms.uUvOffset.value.set(0, 0);
    } else {
        uniforms.uUvScale.value.set((obj.nc - 1) / obj.nc, (obj.nr - 1) / obj.nr);
        uniforms.uUvOffset.value.set(0.5 / obj.nc, 0.5 / obj.nr);
    }

    if (obj.plane) {
        obj.plane.visible = state.planeOn;
        obj.plane.position.y = state.level * obj.baseExag;
    }

    dom.valLevel.textContent = `${state.level.toFixed(1)} км`;
    const thr = state.snowThreshold;
    dom.valThreshold.textContent = thr.toFixed(2);
    dom.snowScaleMin.textContent = `p = ${thr.toFixed(2)}`;
    dom.snowHint.textContent = layerIsSnow
        ? 'На слоях вероятности снега и аномальности снег поверх слоя не рисуется: слой сам его показывает.'
        : 'Области с вероятностью выше порога окрашены цветом снега.';
}

// --------------------------------------------------------------------------
// Relief exaggeration
// --------------------------------------------------------------------------
let exagFrame = 0;
function scheduleExaggeration() {
    if (exagFrame) return;
    exagFrame = requestAnimationFrame(() => {
        exagFrame = 0;
        applyExaggeration();
        rebuildOverlays();
    });
}

function applyExaggeration() {
    const obj = activeObject();
    if (!obj) return;
    const exag = state.exag[state.activeObjectId];
    dom.valExag.textContent = `${exag}×`;

    if (obj.globe) {
        // Globe: r = 1 + h·exag / R → rescale the radial relief of every vertex
        const k = exag / obj.baseExag;
        const base = obj.basePositions;
        const geo = obj.mesh.geometry;
        const arr = geo.attributes.position.array;
        for (let i = 0; i < base.length; i += 3) {
            const x = base[i], y = base[i + 1], z = base[i + 2];
            const r0 = Math.sqrt(x * x + y * y + z * z);
            const s = (1 + (r0 - 1) * k) / r0;
            arr[i] = x * s;
            arr[i + 1] = y * s;
            arr[i + 2] = z * s;
        }
        geo.attributes.position.needsUpdate = true;
        geo.computeVertexNormals();
        geo.computeBoundingSphere();

        // BSR tracks follow the new relief; the gap above it grows a little
        // with the exaggeration so steep slopes never poke through the line
        if (bsrOverlay) {
            bsrOverlay.lift = 0.0006 + exag * 1.5e-5;
            if (bsrOverlay.tracksData && bsrOverlay.surfaceRadius) bsrOverlay.buildGeometry();
        }
    } else {
        // Regions: Y = height × exaggeration → scale the terrain group vertically
        obj.terrainGroup.scale.y = exag / obj.baseExag;
    }
}

// --------------------------------------------------------------------------
// Relief radius of the globe at any (lat, lon)
// --------------------------------------------------------------------------
/**
 * The globe mesh is a regular lat/lon grid: rows from north to south, columns
 * from 180°W eastwards with the seam column duplicated, cells split by the
 * diagonal top-right → bottom-left (as in venus_globe.glb). The radius is
 * interpolated on the same triangles the GPU draws, so whatever lies at this
 * radius sits exactly on the visible surface.
 */
function globeGridInfo(obj) {
    if (obj.grid) return obj.grid;
    const uv = obj.mesh.geometry.attributes.uv;
    let cols = 1;
    while (cols < uv.count && Math.abs(uv.getY(cols) - uv.getY(0)) < 1e-7) cols++;
    const rows = Math.round(uv.count / cols);
    obj.grid = {
        rows,
        cols,
        lat0: 90 - uv.getY(0) * 180,         // latitude of row 0
        lon0: uv.getX(0) * 360 - 180,        // longitude of column 0
        dLat: 180 / rows,
        dLon: 360 / (cols - 1)
    };
    return obj.grid;
}

function globeSurfaceRadius(obj, latDeg, lonDeg) {
    const g = globeGridInfo(obj);
    const pos = obj.mesh.geometry.attributes.position.array;
    const radiusAt = (r, c) => {
        const i = (r * g.cols + c) * 3;
        return Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    };

    let fy = (g.lat0 - latDeg) / g.dLat;
    fy = Math.max(0, Math.min(g.rows - 1 - 1e-6, fy));
    let fx = (lonDeg - g.lon0) / g.dLon;
    const period = g.cols - 1;
    fx = ((fx % period) + period) % period;

    const r = Math.min(Math.floor(fy), g.rows - 2);
    const c = Math.min(Math.floor(fx), g.cols - 2);
    const ty = fy - r, tx = fx - c;

    const tl = radiusAt(r, c), tr = radiusAt(r, c + 1);
    const bl = radiusAt(r + 1, c), br = radiusAt(r + 1, c + 1);
    // Triangles (TL, BL, TR) and (TR, BL, BR)
    if (tx + ty <= 1) return tl + (tr - tl) * tx + (bl - tl) * ty;
    return br + (bl - br) * (1 - tx) + (tr - br) * (1 - ty);
}

// --------------------------------------------------------------------------
// Overlays: coordinate grid (regions) and region frames (globe)
// --------------------------------------------------------------------------
function disposeObject(root) {
    root.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                if (m.map) m.map.dispose();
                m.dispose();
            });
        }
    });
}

function rebuildOverlays() {
    const obj = activeObject();
    if (!obj) return;
    const group = obj.overlayGroup;
    while (group.children.length) {
        const child = group.children[0];
        group.remove(child);
        disposeObject(child);
    }
    if (obj.globe) {
        if (state.showFrames) buildRegionFrames(obj, group);
    } else if (state.showGrid) {
        buildCoordinateGrid(obj, group);
    }
}

function makeLabel(text, worldHeight, color, { bold = false } = {}) {
    const fontPx = 48;
    const font = `${bold ? '600 ' : ''}${fontPx}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 16;
    const h = fontPx + 16;
    canvas.width = w;
    canvas.height = h;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(worldHeight * w / h, worldHeight, 1);
    sprite.renderOrder = 5;
    return sprite;
}

function niceStep(span, target = 6) {
    const raw = span / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (raw <= m * pow) return m * pow;
    }
    return 10 * pow;
}

function ticks(min, max, step) {
    const out = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) {
        out.push(Math.round(v * 1e6) / 1e6);
    }
    return out;
}

function fmtDeg(v) {
    const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
    return `${s.replace('-', '−')}°`;
}

function buildCoordinateGrid(obj, group) {
    const { meta, extent } = obj;
    const exag = state.exag[meta.id];
    const { lat, lon } = meta.bounds;
    const X = extent.halfX, Z = extent.halfZ;
    const [eMin, eMax] = meta.height_range_km || [0, 10];
    const hMin = Math.floor(Math.min(eMin, 0));
    const hMax = Math.ceil(eMax);
    const y0 = hMin * exag, y1 = hMax * exag;

    const labelColor = cssVar('--grid-label', '#334155');
    const lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(cssVar('--grid-line', '#0f172a')),
        transparent: true,
        opacity: parseFloat(cssVar('--grid-line-opacity', '0.28')),
        depthWrite: false
    });

    const lonToX = (v) => -X + (v - lon[0]) / (lon[1] - lon[0]) * 2 * X;
    const latToZ = (v) => -Z + (lat[1] - v) / (lat[1] - lat[0]) * 2 * Z;

    const lonTicks = ticks(lon[0], lon[1], niceStep(lon[1] - lon[0], 6));
    const latTicks = ticks(lat[0], lat[1], niceStep(lat[1] - lat[0], 6));

    const labelSize = Math.max(X, Z) * 0.045;
    // Height ticks: keep labels from overlapping at small exaggeration
    let hStep = niceStep(hMax - hMin, 5);
    while (hStep * exag < labelSize * 1.3 && hStep < (hMax - hMin)) hStep = niceStep(hStep * 2.2, 1);
    const hTicks = ticks(hMin, hMax, hStep);

    const pts = [];
    const seg = (a, b) => pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);

    // Floor grid
    lonTicks.forEach((v) => seg([lonToX(v), y0, -Z], [lonToX(v), y0, Z]));
    latTicks.forEach((v) => seg([-X, y0, latToZ(v)], [X, y0, latToZ(v)]));
    seg([-X, y0, -Z], [X, y0, -Z]); seg([X, y0, -Z], [X, y0, Z]);
    seg([X, y0, Z], [-X, y0, Z]); seg([-X, y0, Z], [-X, y0, -Z]);

    // North wall (z = −Z) and west wall (x = −X), like the back planes in Plotly
    lonTicks.forEach((v) => seg([lonToX(v), y0, -Z], [lonToX(v), y1, -Z]));
    latTicks.forEach((v) => seg([-X, y0, latToZ(v)], [-X, y1, latToZ(v)]));
    hTicks.forEach((h) => {
        seg([-X, h * exag, -Z], [X, h * exag, -Z]);
        seg([-X, h * exag, -Z], [-X, h * exag, Z]);
    });
    seg([-X, y0, -Z], [-X, y1, -Z]);
    seg([X, y0, -Z], [X, y1, -Z]);
    seg([-X, y0, Z], [-X, y1, Z]);
    seg([-X, y1, -Z], [X, y1, -Z]);
    seg([-X, y1, -Z], [-X, y1, Z]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo, lineMat);
    lines.renderOrder = 1;
    group.add(lines);

    // Tick labels
    const off = labelSize * 1.2;
    let maxLatLabelW = 0;
    lonTicks.forEach((v) => {
        const s = makeLabel(fmtDeg(v), labelSize, labelColor);
        s.position.set(lonToX(v), y0, Z + off);
        group.add(s);
    });
    latTicks.forEach((v) => {
        const s = makeLabel(fmtDeg(v), labelSize, labelColor);
        maxLatLabelW = Math.max(maxLatLabelW, s.scale.x);
        s.position.set(X + off * 0.4 + s.scale.x / 2, y0, latToZ(v));
        group.add(s);
    });
    hTicks.forEach((h) => {
        const s = makeLabel(String(h).replace('-', '−'), labelSize, labelColor);
        s.position.set(X + off * 0.9, h * exag, -Z - off * 0.6);
        group.add(s);
    });

    // Axis titles
    const titleSize = labelSize * 1.05;
    const tLon = makeLabel('долгота, ° в.д.', titleSize, labelColor, { bold: true });
    tLon.position.set(0, y0, Z + off * 2.6);
    group.add(tLon);
    const tLat = makeLabel('широта, °', titleSize, labelColor, { bold: true });
    tLat.position.set(X + off * 0.9 + maxLatLabelW + tLat.scale.x / 2, y0, 0);
    group.add(tLat);
    const tH = makeLabel('высота, км', titleSize, labelColor, { bold: true });
    tH.position.set(X + off * 0.9, y1 + off * 1.4, -Z - off * 0.6);
    group.add(tH);
}

function latLonToVec(latDeg, lonDeg, r) {
    const p = latDeg * Math.PI / 180, l = lonDeg * Math.PI / 180;
    // glTF: +X → (0°N, 0°E), +Y → north pole, −Z → 90°E
    return new THREE.Vector3(r * Math.cos(p) * Math.cos(l), r * Math.sin(p), -r * Math.cos(p) * Math.sin(l));
}

function buildRegionFrames(obj, group) {
    const exag = state.exag[obj.meta.id];
    // Frames hang at a fixed level above the highest peak of their region, so
    // they rise in proportion to the exaggerated relief and never touch it.
    // The gap grows slightly with the exaggeration as well.
    const frameGap = 0.03 + exag * 1.0 / R_KM;
    const labelGap = 0.02;          // labels sit a little higher than the frames
    const color = cssVar('--frame-line', '#0284c7');
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(color) });

    // Highest relief inside a lat/lon box (sampled finer than the 0.5° mesh)
    const maxRadiusIn = (lat, lon) => {
        let rMax = 1;
        for (let la = lat[0]; la <= lat[1] + 1e-9; la += 0.1) {
            for (let lo = lon[0]; lo <= lon[1] + 1e-9; lo += 0.1) {
                rMax = Math.max(rMax, globeSurfaceRadius(obj, la, lo));
            }
        }
        return rMax;
    };

    state.manifest.objects.filter((o) => !isGlobe(o) && o.bounds).forEach((o) => {
        const { lat, lon } = o.bounds;
        const labelLat = Math.min(lat[1] + 2.5, 89);
        const labelLon = (lon[0] + lon[1]) / 2;

        // Frame level: above the region and above the relief under the label
        const rFrame = Math.max(
            maxRadiusIn(lat, lon),
            maxRadiusIn([labelLat - 1.5, labelLat + 0.5], [labelLon - 4, labelLon + 4])
        ) + frameGap;

        // Closed frame at constant radius, sampled along the parallels and meridians
        const corners = [[lat[1], lon[0]], [lat[1], lon[1]], [lat[0], lon[1]], [lat[0], lon[0]], [lat[1], lon[0]]];
        const pts = [];
        for (let e = 0; e < 4; e++) {
            const [la0, lo0] = corners[e], [la1, lo1] = corners[e + 1];
            const n = Math.max(2, Math.ceil(Math.max(Math.abs(la1 - la0), Math.abs(lo1 - lo0)) / 0.5));
            for (let i = e === 0 ? 0 : 1; i <= n; i++) {
                pts.push(latLonToVec(la0 + (la1 - la0) * i / n, lo0 + (lo1 - lo0) * i / n, rFrame));
            }
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat.clone());
        line.renderOrder = 3;
        group.add(line);

        const label = makeLabel(o.name, 0.05, color, { bold: true });
        label.position.copy(latLonToVec(labelLat, labelLon, rFrame + labelGap));
        group.add(label);
    });
    lineMat.dispose();
}

// --------------------------------------------------------------------------
// Camera
// --------------------------------------------------------------------------
function fitCameraToObject(obj) {
    if (obj.globe) {
        controls.target.set(0, 0, 0);
        camera.position.set(1.9, 1.2, 2.4).normalize().multiplyScalar(3.6);
        camera.near = 0.01;
        camera.far = 100;
        controls.minDistance = 1.3;
        controls.maxDistance = 12;
    } else {
        const { halfX, halfZ } = obj.extent;
        const radius = Math.sqrt(halfX * halfX + halfZ * halfZ);
        const fov = camera.fov * Math.PI / 180;
        const distance = radius / Math.sin(fov / 2) * 1.4;
        controls.target.set(0, 0, 0);
        // Looking from the south-west, like the reference pages
        const dir = new THREE.Vector3(-1.3, 0.95, 1.5).normalize();
        camera.position.copy(dir.multiplyScalar(distance));
        camera.near = radius * 0.005;
        camera.far = radius * 30;
        controls.minDistance = radius * 0.1;
        controls.maxDistance = radius * 8;
    }
    updateViewOffset();
    controls.update();
}

// --------------------------------------------------------------------------
// UI: pills, selects, legend, telemetry
// --------------------------------------------------------------------------
function initUI() {
    buildRegionPills();

    dom.selectLayer.innerHTML = '';
    const layers = state.manifest.layers || {};
    LAYER_ORDER.filter((k) => layers[k]).forEach((key) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = layers[key].title;
        dom.selectLayer.appendChild(opt);
    });
    dom.selectLayer.value = state.activeLayerId;

    dom.selectSnowSource.value = state.snowSource;
    dom.selectViewMode.value = state.viewMode;
    dom.sliderThreshold.value = state.snowThreshold;
    dom.checkShowSnow.checked = state.showSnow;
    dom.checkContours.checked = state.contours;
    dom.checkPlane.checked = state.planeOn;
    dom.checkGrid.checked = state.showGrid;
    dom.checkFrames.checked = state.showFrames;
    dom.checkAutorotate.checked = state.autoRotate;
    dom.checkBsrTracks.checked = state.bsrVisible;
}

function buildRegionPills() {
    dom.regionPills.innerHTML = '';
    // Globe and "Гора Гула" swap places in the switcher
    const order = state.manifest.objects.slice();
    const iGlobe = order.findIndex((o) => isGlobe(o));
    const iGula = order.findIndex((o) => o.id === 'region_gora_gula');
    if (iGlobe >= 0 && iGula >= 0) [order[iGlobe], order[iGula]] = [order[iGula], order[iGlobe]];
    order.forEach((obj) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'model-pill';
        btn.dataset.id = obj.id;
        btn.textContent = obj.name;
        btn.addEventListener('click', () => {
            if (obj.id !== state.activeObjectId) switchModel(obj.id);
        });
        dom.regionPills.appendChild(btn);
    });
}

function updateActivePills() {
    dom.regionPills.querySelectorAll('.model-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.id === state.activeObjectId);
    });
}

function fmtNum(v, digits = 0) {
    return v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function updateLegend() {
    const layers = state.manifest.layers || {};
    const lInfo = layers[state.activeLayerId];
    if (!lInfo) return;

    dom.legendTitle.textContent = lInfo.title;

    if (lInfo.type === 'categorical' && lInfo.labels) {
        dom.legendContinuousWrap.style.display = 'none';
        dom.legendCategorical.style.display = 'flex';
        dom.legendCategorical.innerHTML = '';
        lInfo.labels.forEach((label, idx) => {
            const item = document.createElement('div');
            item.className = 'legend-cat-item';
            const dot = document.createElement('span');
            dot.className = 'legend-cat-dot';
            dot.style.background = lInfo.colors[idx] || '#888';
            const text = document.createElement('span');
            text.textContent = label;
            item.append(dot, text);
            dom.legendCategorical.appendChild(item);
        });
    } else {
        dom.legendCategorical.style.display = 'none';
        dom.legendContinuousWrap.style.display = 'flex';
        dom.legendBar.style.background = `linear-gradient(90deg, ${(lInfo.colors || ['#000', '#fff']).join(', ')})`;
        const [a, b] = lInfo.range || [0, 1];
        const digits = Math.abs(b - a) < 2 ? 2 : 1;
        dom.legendTicks.innerHTML = '';
        [a, (a + b) / 2, b].forEach((v) => {
            const s = document.createElement('span');
            s.textContent = fmtNum(v, digits);
            dom.legendTicks.appendChild(s);
        });
    }
}

function updateTelemetry() {
    const obj = activeObject();
    if (!obj) return;
    const { meta } = obj;
    const thr = state.snowThreshold;
    const snowArea = snowAreaFor(obj, state.snowSource, thr);
    const srcLabel = state.snowSource === 'anomaly' ? 'аномальность' : 'классификатор';
    const rows = [];

    if (obj.globe) {
        const [hMin, hMax] = meta.height_range_km || [0, 0];
        rows.push(['объект', meta.name, true]);
        rows.push(['диапазон высот', `${fmtNum(hMin, 1)} … ${fmtNum(hMax, 1)} км`]);
        rows.push([`площадь снега при p ≥ ${thr.toFixed(2)} (${srcLabel})`, `${fmtNum(Math.round(snowArea))} км²`]);
        rows.push(['доля поверхности под снегом', `${fmtNum(100 * snowArea / Math.max(obj.totalArea, 1), 2)} %`]);
        rows.push(['вертикальное преувеличение', `${state.exag[meta.id]}×`]);
    } else {
        rows.push(['регион', meta.name, true]);
        rows.push(['максимальная высота', `${fmtNum((meta.height_range_km || [0, 0])[1], 2)} км`]);
        rows.push(['снеговая линия h_c', meta.snowline_km != null ? `${fmtNum(meta.snowline_km, 2)} км` : 'не выделена']);
        rows.push([`площадь снега при p ≥ ${thr.toFixed(2)} (${srcLabel})`, `${fmtNum(Math.round(snowArea))} км²`]);
        rows.push(['доля региона под снегом', `${fmtNum(100 * snowArea / Math.max(obj.totalArea, 1), 2)} %`]);

        if (state.planeOn && obj.heights) {
            let aAbove = 0, eA = 0, nA = 0, eB = 0, nB = 0;
            const { nr, nc, heights, emis, rowArea } = obj;
            for (let r = 0; r < nr; r++) {
                for (let c = 0; c < nc; c++) {
                    const i = r * nc + c;
                    if (heights[i] >= state.level) {
                        aAbove += rowArea[r];
                        if (emis) { eA += emis[i]; nA++; }
                    } else if (emis) {
                        eB += emis[i]; nB++;
                    }
                }
            }
            rows.push([`площадь выше плоскости ${state.level.toFixed(1)} км`, `${fmtNum(Math.round(aAbove))} км²`]);
            rows.push(['излучательная способность выше / ниже плоскости',
                emis ? `${nA ? fmtNum(eA / nA, 3) : '—'} / ${nB ? fmtNum(eB / nB, 3) : '—'}` : 'нет данных']);
        } else {
            rows.push(['площадь выше плоскости', 'плоскость скрыта']);
        }
    }

    dom.telemetry.innerHTML = '';
    rows.forEach(([label, value, accent]) => {
        const row = document.createElement('div');
        row.className = 'telemetry-row';
        const l = document.createElement('span');
        l.className = 'telemetry-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = `telemetry-value${accent ? ' accent' : ''}`;
        v.textContent = value;
        row.append(l, v);
        dom.telemetry.appendChild(row);
    });
}

// --------------------------------------------------------------------------
// Top-down map (regions)
// --------------------------------------------------------------------------
const topmap = { plot: null };

/** Marching squares: line segments [c0, r0, c1, r1, …] in grid coordinates. */
function contourSegments(values, nr, nc, level) {
    const segs = [];
    const lerp = (a, b) => (level - a) / (b - a);
    for (let r = 0; r < nr - 1; r++) {
        for (let c = 0; c < nc - 1; c++) {
            const v0 = values[r * nc + c];           // top-left
            const v1 = values[r * nc + c + 1];       // top-right
            const v2 = values[(r + 1) * nc + c + 1]; // bottom-right
            const v3 = values[(r + 1) * nc + c];     // bottom-left
            const idx = (v0 >= level ? 8 : 0) | (v1 >= level ? 4 : 0) | (v2 >= level ? 2 : 0) | (v3 >= level ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const top = [c + lerp(v0, v1), r];
            const right = [c + 1, r + lerp(v1, v2)];
            const bottom = [c + lerp(v3, v2), r + 1];
            const left = [c, r + lerp(v0, v3)];
            const add = (a, b) => segs.push(a[0], a[1], b[0], b[1]);
            switch (idx) {
                case 1: case 14: add(left, bottom); break;
                case 2: case 13: add(bottom, right); break;
                case 3: case 12: add(left, right); break;
                case 4: case 11: add(top, right); break;
                case 6: case 9: add(top, bottom); break;
                case 7: case 8: add(left, top); break;
                case 5: add(left, top); add(bottom, right); break;
                case 10: add(top, right); add(left, bottom); break;
                default: break;
            }
        }
    }
    return segs;
}

function drawTopMap() {
    const obj = activeObject();
    const canvas = dom.topmapCanvas;
    if (!obj || obj.globe || !canvas || !obj.layerImage || !obj.nr) return;

    const { meta, nr, nc } = obj;
    const { lat, lon } = meta.bounds;
    const thr = state.snowThreshold;

    const cssW = canvas.parentElement.clientWidth - 12;
    if (cssW <= 0) return;
    const ml = 40, mr = 8, mt = 6, mb = 26;
    const mlat = (lat[0] + lat[1]) / 2;
    // Equal-area-ish aspect, as Plotly's scaleratio = 1 / cos(mean latitude)
    const ratio = ((lon[1] - lon[0]) * Math.cos(mlat * Math.PI / 180)) / (lat[1] - lat[0]);
    let plotW = cssW - ml - mr;
    let plotH = plotW / ratio;
    if (plotH > 250) { plotH = 250; plotW = plotH * ratio; }
    const cssH = plotH + mt + mb;
    const x0 = ml + (cssW - ml - mr - plotW) / 2, y0 = mt;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Layer as a heat map
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(obj.layerImage, x0, y0, plotW, plotH);

    // Grid coordinates (pixel centres) → canvas
    const gx = (c) => x0 + (c + 0.5) / nc * plotW;
    const gy = (r) => y0 + (r + 0.5) / nr * plotH;
    const drawSegs = (segs) => {
        ctx.beginPath();
        for (let i = 0; i < segs.length; i += 4) {
            ctx.moveTo(gx(segs[i]), gy(segs[i + 1]));
            ctx.lineTo(gx(segs[i + 2]), gy(segs[i + 3]));
        }
        ctx.stroke();
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, plotW, plotH);
    ctx.clip();

    // Snow boundary at the threshold
    const snow = obj.snow[state.snowSource];
    if (snow && state.showSnow) {
        const p = new Float32Array(snow.length);
        for (let i = 0; i < snow.length; i++) p[i] = Math.min(snow[i] / GRAY_SCALE, 1);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([]);
        drawSegs(contourSegments(p, nr, nc, thr));
    }

    // Snowline isoline at the plane level
    if (state.planeOn && obj.heights) {
        ctx.strokeStyle = LEVEL_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        drawSegs(contourSegments(obj.heights, nr, nc, state.level));
        ctx.setLineDash([]);
    }
    ctx.restore();

    // Frame and axes
    ctx.strokeStyle = cssVar('--border-input', '#cbd5e1');
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, plotW - 1, plotH - 1);

    ctx.fillStyle = cssVar('--text-secondary', '#475569');
    ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ticks(lon[0], lon[1], niceStep(lon[1] - lon[0], 4)).forEach((v) => {
        const x = x0 + (v - lon[0]) / (lon[1] - lon[0]) * plotW;
        ctx.fillRect(x, y0 + plotH, 1, 4);
        ctx.fillText(fmtDeg(v), x, y0 + plotH + 6);
    });
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks(lat[0], lat[1], niceStep(lat[1] - lat[0], 4)).forEach((v) => {
        const y = y0 + (lat[1] - v) / (lat[1] - lat[0]) * plotH;
        ctx.fillRect(x0 - 4, y, 4, 1);
        ctx.fillText(fmtDeg(v), x0 - 6, y);
    });

    topmap.plot = { x0, y0, plotW, plotH };

    dom.topmapLegendSnow.textContent = `граница снега, p = ${thr.toFixed(2)}`;
    dom.topmapLegendLevel.textContent = `изолиния снеговой линии, ${state.level.toFixed(2)} км`;
    dom.topmapLegendLevelRow.style.display = state.planeOn ? '' : 'none';
}

function onTopMapMove(e) {
    const obj = activeObject();
    if (!obj || obj.globe || !topmap.plot) return;
    const rect = dom.topmapCanvas.getBoundingClientRect();
    const { x0, y0, plotW, plotH } = topmap.plot;
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < x0 || x > x0 + plotW || y < y0 || y > y0 + plotH) {
        dom.topmapReadout.textContent = '';
        return;
    }
    const { lat, lon } = obj.meta.bounds;
    const c = Math.min(obj.nc - 1, Math.floor((x - x0) / plotW * obj.nc));
    const r = Math.min(obj.nr - 1, Math.floor((y - y0) / plotH * obj.nr));
    const la = lat[1] - (y - y0) / plotH * (lat[1] - lat[0]);
    const lo = lon[0] + (x - x0) / plotW * (lon[1] - lon[0]);
    const i = r * obj.nc + c;
    const h = obj.heights ? ` · ${obj.heights[i].toFixed(2)} км` : '';
    const snow = obj.snow[state.snowSource];
    const p = snow ? ` · p ${Math.min(snow[i] / GRAY_SCALE, 1).toFixed(2)}` : '';
    dom.topmapReadout.textContent = `${lo.toFixed(1)}°, ${la.toFixed(1)}°${h}${p}`;
}

// --------------------------------------------------------------------------
// Event listeners
// --------------------------------------------------------------------------
function initEventListeners() {
    dom.themeToggle.addEventListener('click', toggleTheme);

    dom.selectLayer.addEventListener('change', (e) => {
        applyLayer(e.target.value).catch((err) => console.error(err));
    });

    dom.selectSnowSource.addEventListener('change', (e) => {
        state.snowSource = e.target.value;
        syncUniforms();
        updateTelemetry();
        drawTopMap();
    });

    dom.selectViewMode.addEventListener('change', (e) => {
        state.viewMode = e.target.value;
        syncUniforms();
    });

    dom.sliderThreshold.addEventListener('input', (e) => {
        state.snowThreshold = parseFloat(e.target.value);
        syncUniforms();
        updateTelemetry();
        drawTopMap();
    });

    dom.sliderExag.addEventListener('input', (e) => {
        if (!state.activeObjectId) return;
        state.exag[state.activeObjectId] = parseInt(e.target.value, 10);
        dom.valExag.textContent = `${e.target.value}×`;
        scheduleExaggeration();
        updateTelemetry();
    });

    dom.checkPlane.addEventListener('change', (e) => {
        state.planeOn = e.target.checked;
        syncUniforms();
        updateTelemetry();
        drawTopMap();
    });

    dom.sliderLevel.addEventListener('input', (e) => {
        state.level = parseFloat(e.target.value);
        syncUniforms();
        updateTelemetry();
        drawTopMap();
    });

    dom.checkShowSnow.addEventListener('change', (e) => {
        state.showSnow = e.target.checked;
        syncUniforms();
        drawTopMap();
    });

    dom.checkContours.addEventListener('change', (e) => {
        state.contours = e.target.checked;
        syncUniforms();
    });

    dom.checkGrid.addEventListener('change', (e) => {
        state.showGrid = e.target.checked;
        rebuildOverlays();
    });

    dom.checkFrames.addEventListener('change', (e) => {
        state.showFrames = e.target.checked;
        rebuildOverlays();
    });

    dom.checkAutorotate.addEventListener('change', (e) => {
        state.autoRotate = e.target.checked;
        controls.autoRotate = state.autoRotate;
    });

    dom.checkBsrTracks.addEventListener('change', (e) => {
        state.bsrVisible = e.target.checked;
        const obj = activeObject();
        if (bsrOverlay) bsrOverlay.setVisible(Boolean(state.bsrVisible && obj && obj.globe));
    });

    dom.topmapCanvas.addEventListener('mousemove', onTopMapMove);
    dom.topmapCanvas.addEventListener('mouseleave', () => { dom.topmapReadout.textContent = ''; });

    dom.btnExportGlb.addEventListener('click', downloadCurrentGLB);
    dom.btnExportObj.addEventListener('click', exportToOBJ);
    dom.btnSnapshot.addEventListener('click', captureSnapshot);

    dom.btnOpenInfo.addEventListener('click', () => dom.modalBackdrop.classList.add('active'));
    dom.btnCloseModal.addEventListener('click', () => dom.modalBackdrop.classList.remove('active'));
    dom.modalBackdrop.addEventListener('click', (e) => {
        if (e.target === dom.modalBackdrop) dom.modalBackdrop.classList.remove('active');
    });

    // Follow the system theme only while the user has not picked one
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) {
            mq.addEventListener('change', (e) => {
                let saved = null;
                try { saved = localStorage.getItem('venus-theme'); } catch (err) { /* ignore */ }
                if (saved) return;
                document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                applyThemeToScene();
            });
        }
    }
}

// --------------------------------------------------------------------------
// Export handlers
// --------------------------------------------------------------------------
function downloadCurrentGLB() {
    const obj = activeObject();
    if (!obj) return;
    const a = document.createElement('a');
    a.href = `/export_3d/${obj.meta.glb}`;
    a.download = obj.meta.glb;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function exportToOBJ() {
    const obj = activeObject();
    if (!obj) {
        alert('Сначала дождитесь загрузки модели.');
        return;
    }

    // Bake the current relief exaggeration into the exported geometry
    const geo = obj.mesh.geometry.clone();
    if (!obj.globe) geo.scale(1, obj.terrainGroup.scale.y, 1);
    const exportMesh = new THREE.Mesh(geo);
    exportMesh.name = obj.meta.id;

    const modelName = obj.meta.id;
    const mtlName = `${modelName}.mtl`;
    const textureName = `${modelName}_${state.activeLayerId}.png`;

    const result = new OBJExporter().parse(exportMesh, mtlName, textureName);
    geo.dispose();
    OBJExporter.downloadFile(`${modelName}.obj`, result.obj, 'model/obj');
    setTimeout(() => OBJExporter.downloadFile(mtlName, result.mtl, 'model/mtl'), 400);
}

function captureSnapshot() {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = `venus_${state.activeObjectId}_${state.activeLayerId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
function onWindowResize() {
    const container = document.getElementById('app-viewport');
    camera.aspect = container.clientWidth / container.clientHeight;
    renderer.setSize(container.clientWidth, container.clientHeight);
    updateViewOffset();
    drawTopMap();
}

/** Shifts the projection so the model is centred in the free space between the side panels. */
function updateViewOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    const left = document.querySelector('.main-panel');
    const right = document.querySelector('.legend-panel');
    const lr = left ? left.getBoundingClientRect() : null;
    const rr = right ? right.getBoundingClientRect() : null;
    const leftEdge = lr && lr.width && lr.right < w * 0.6 ? lr.right : 0;
    const rightEdge = rr && rr.width ? rr.left : w;
    if (rightEdge - leftEdge < w * 0.3) {
        camera.clearViewOffset();
    } else {
        const centre = (leftEdge + rightEdge) / 2;
        camera.setViewOffset(w, h, w / 2 - centre, 0, w, h);
    }
    camera.updateProjectionMatrix();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('DOMContentLoaded', () => {
    initApp().catch((err) => {
        console.error('Ошибка инициализации приложения:', err);
        updateLoadingProgress(`Ошибка запуска: ${err.message}`);
    });
});