/**
 * Venus 3D Interactive Atlas — Main Application
 * ---------------------------------------------
 * Three.js WebGL Engine, GLTF Loader, Dynamic Snowline Shader,
 * Wavefront OBJ/GLB Exporter, and Telemetry HUD.
 *
 * Theme: Light Clean Style (Matches Screenshot 2)
 * Author: Vasiliy Guryanov
 */

import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import { OBJExporter } from './obj_exporter.js';
import { BSROverlay } from './bsr_overlay.js';

// Application State
const state = {
    manifest: null,
    summary: null,
    activeObjectId: 'globe',
    activeLayerId: 'elev',
    activeModelData: null,
    activeMesh: null,
    loadedTextures: {},
    snowThreshold: 0.77,
    snowOverlayEnabled: true,
    snowIsolate: false,
    material: {
        roughness: 0.82,
        metalness: 0.75,
        displayMode: 'solid'
    },
    lighting: {
        azimuth: 45,
        elevation: 50,
        sunIntensity: 2.2,
        ambientIntensity: 0.8
    },
    camera: {
        autoRotate: true,
        rotateSpeed: 0.5
    },
    bsrVisible: false
};

// Three.js Core Objects
let scene, camera, renderer, controls, sunLight, ambientLight;
let bsrOverlay = null;
let activeGroup = null;
let wireframeClone = null;
let pointsClone = null;

// DOM References
const dom = {};

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
async function initApp() {
    bindDomElements();
    updateLoadingProgress('Инициализация 3D-сцены WebGL...');

    initThreeScene();
    updateLoadingProgress('Получение каталога моделей и метаданных...');

    await loadManifestAndMetadata();
    updateLoadingProgress('Построение интерфейса...');

    initUI();
    initEventListeners();

    updateLoadingProgress('Загрузка 3D-модели Венеры...');
    await switchModel('globe');

    dom.loadingOverlay.classList.add('hidden');
    animate();
}

/**
 * Sets up Renderer, Camera, Lights and Scene for Light Theme.
 */
function initThreeScene() {
    const container = document.getElementById('app-viewport');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // 1. Scene with soft light background (Screenshot 2 theme)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe8edf5);

    // 2. Perspective Camera
    camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 5000);
    camera.position.set(2.2, 1.4, 2.8);

    // 3. WebGL Renderer
    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('canvas3d'),
        antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    // 4. OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = state.camera.autoRotate;
    controls.autoRotateSpeed = state.camera.rotateSpeed;
    controls.minDistance = 0.6;
    controls.maxDistance = 1500;

    // 5. Studio Lighting for Light Theme
    ambientLight = new THREE.AmbientLight(0xffffff, state.lighting.ambientIntensity);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xfff7ed, state.lighting.sunIntensity);
    updateSunPosition();
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0xbae6fd, 0.65);
    fillLight.position.set(-3, 2, -2);
    scene.add(fillLight);

    // 6. Active Group container for current loaded mesh
    activeGroup = new THREE.Group();
    activeGroup.name = 'active_model_group';
    scene.add(activeGroup);

    // 7. BSR Overlay
    bsrOverlay = new BSROverlay(THREE, { radius: 1.008 });
    scene.add(bsrOverlay.group);

    window.addEventListener('resize', onWindowResize);
}

/**
 * Computes directional Sun position from Azimuth and Elevation.
 */
function updateSunPosition() {
    const r = 10;
    const phi = (90 - state.lighting.elevation) * (Math.PI / 180);
    const theta = (state.lighting.azimuth) * (Math.PI / 180);

    const x = r * Math.sin(phi) * Math.sin(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.cos(theta);

    sunLight.position.set(x, y, z);
    sunLight.intensity = state.lighting.sunIntensity;
    ambientLight.intensity = state.lighting.ambientIntensity;
}

// --------------------------------------------------------------------------
// Metadata & Manifest Loader
// --------------------------------------------------------------------------
async function loadManifestAndMetadata() {
    try {
        const resp = await fetch('/api/regions');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        state.manifest = data;
        state.summary = data;
    } catch (err) {
        console.warn('Fallback to /api/manifest...', err);
        const mResp = await fetch('/api/manifest');
        state.manifest = await mResp.json();
    }
}

// --------------------------------------------------------------------------
// Model & Texture Switching Engine
// --------------------------------------------------------------------------
async function switchModel(objectId) {
    if (!state.manifest || !state.manifest.objects) return;

    const objData = state.manifest.objects.find(o => o.id === objectId);
    if (!objData) return;

    state.activeObjectId = objectId;
    state.activeModelData = objData;

    dom.loadingOverlay.classList.remove('hidden');
    updateLoadingProgress(`Загрузка 3D-модели: ${objData.name}...`);

    while (activeGroup.children.length > 0) {
        const child = activeGroup.children[0];
        activeGroup.remove(child);
        disposeObject(child);
    }
    wireframeClone = null;
    pointsClone = null;

    if (bsrOverlay) {
        if (objectId === 'globe') {
            if (!bsrOverlay.tracksData) await bsrOverlay.load();
            bsrOverlay.setVisible(state.bsrVisible);
        } else {
            bsrOverlay.setVisible(false);
        }
    }

    const glbUrl = `/export_3d/${objData.glb}`;
    const loader = new GLTFLoader();

    try {
        const gltf = await new Promise((resolve, reject) => {
            loader.load(glbUrl, resolve, undefined, reject);
        });

        const root = gltf.scene;
        let targetMesh = null;

        root.traverse((node) => {
            if (node.isMesh) {
                targetMesh = node;
            }
        });

        if (!targetMesh) throw new Error('No mesh in GLB');

        state.activeMesh = targetMesh;
        activeGroup.add(root);

        // Center and frame camera with horizontal offset to account for left card
        fitCameraToObject(root, objectId === 'globe' ? 1.45 : 1.35);

        // Apply active texture layer and dynamic snow shader
        await applyTextureLayer(state.activeLayerId);

        updateLegend();
        updateActivePills();
        updateSelectInputs();

        dom.loadingOverlay.classList.add('hidden');
    } catch (err) {
        console.error('Error loading model:', err);
        dom.loadingOverlay.classList.add('hidden');
        alert(`Не удалось загрузить модель: ${err.message}`);
    }
}

/**
 * Loads base texture and snow probability mask, then compiles PBR material with dynamic snow shader.
 */
async function applyTextureLayer(layerId) {
    if (!state.activeMesh || !state.activeModelData) return;

    state.activeLayerId = layerId;
    const textures = state.activeModelData.textures || {};
    const relPath = textures[layerId] || textures['elev'];

    const baseTexture = await loadTexturePromise(`/export_3d/${relPath}`);

    // Load snow probability mask for dynamic shader
    const snowProbRelPath = textures['snow_prob_gray'] || textures['snow_prob'];
    const snowProbTexture = await loadTexturePromise(`/export_3d/${snowProbRelPath}`);

    // Compile dynamic PBR material with real-time snow shader
    const mat = createCustomPBRMaterial(baseTexture, snowProbTexture);
    state.activeMesh.material = mat;

    updateLegend();
    updateWireframeAndPoints();
    updateSnowMetricsDisplay(state.snowThreshold);
}

/**
 * Creates custom PBR material with onBeforeCompile real-time snow shader.
 * Moving the threshold slider changes the shader uniform uSnowThreshold at 60 FPS!
 */
function createCustomPBRMaterial(baseTexture, snowProbTexture) {
    const mat = new THREE.MeshStandardMaterial({
        map: baseTexture,
        roughness: state.material.roughness,
        metalness: state.material.metalness
    });

    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uSnowProbMap = { value: snowProbTexture };
        shader.uniforms.uSnowThreshold = { value: state.snowThreshold };
        shader.uniforms.uSnowActive = { value: state.snowOverlayEnabled ? 1 : 0 };
        shader.uniforms.uSnowIsolate = { value: state.snowIsolate ? 1 : 0 };
        shader.uniforms.uSnowColor = { value: new THREE.Color(0xf0f9ff) };
        shader.uniforms.uSnowRimColor = { value: new THREE.Color(0x0284c7) };

        mat.userData.shader = shader;

        shader.fragmentShader = `
            uniform sampler2D uSnowProbMap;
            uniform float uSnowThreshold;
            uniform int uSnowActive;
            uniform int uSnowIsolate;
            uniform vec3 uSnowColor;
            uniform vec3 uSnowRimColor;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `
            #include <dithering_fragment>

            if (uSnowActive == 1) {
                float prob = texture2D(uSnowProbMap, vUv).r;

                if (uSnowIsolate == 1 && prob < uSnowThreshold) {
                    discard;
                }

                if (prob >= uSnowThreshold) {
                    float edge = smoothstep(uSnowThreshold, uSnowThreshold + 0.035, prob);
                    vec3 snowTone = mix(uSnowRimColor, uSnowColor, edge);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, snowTone * (gl_FragColor.rgb * 0.4 + 0.7), 0.9);
                }
            }
            `
        );
    };

    return mat;
}

function loadTexturePromise(url) {
    if (state.loadedTextures[url]) {
        return Promise.resolve(state.loadedTextures[url]);
    }
    const texLoader = new THREE.TextureLoader();
    return new Promise((resolve) => {
        texLoader.load(url, (tex) => {
            tex.flipY = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.generateMipmaps = true;
            state.loadedTextures[url] = tex;
            resolve(tex);
        });
    });
}

function updateWireframeAndPoints() {
    if (!state.activeMesh) return;

    if (wireframeClone) {
        activeGroup.remove(wireframeClone);
        disposeObject(wireframeClone);
        wireframeClone = null;
    }
    if (pointsClone) {
        activeGroup.remove(pointsClone);
        disposeObject(pointsClone);
        pointsClone = null;
    }

    const geo = state.activeMesh.geometry;
    const mode = state.material.displayMode;

    if (mode === 'solid') {
        state.activeMesh.visible = true;
        state.activeMesh.material.wireframe = false;
    } else if (mode === 'wireframe') {
        state.activeMesh.visible = true;
        state.activeMesh.material.wireframe = true;
    } else if (mode === 'overlay') {
        state.activeMesh.visible = true;
        state.activeMesh.material.wireframe = false;
        const wfMat = new THREE.MeshBasicMaterial({
            color: 0x0284c7,
            wireframe: true,
            transparent: true,
            opacity: 0.35
        });
        wireframeClone = new THREE.Mesh(geo, wfMat);
        activeGroup.add(wireframeClone);
    } else if (mode === 'points') {
        state.activeMesh.visible = false;
        const ptsMat = new THREE.PointsMaterial({
            size: 1.8,
            color: 0x0284c7,
            transparent: true,
            opacity: 0.85
        });
        pointsClone = new THREE.Points(geo, ptsMat);
        activeGroup.add(pointsClone);
    }
}

/**
 * Frames object with subtle horizontal target offset so it centers between left and right cards.
 */
function fitCameraToObject(object, offsetFactor = 1.4) {
    const box = new THREE.Box3().setFromObject(object);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = sphere.radius || 1;

    const fov = camera.fov * (Math.PI / 180);
    const distance = (radius / Math.sin(fov / 2)) * offsetFactor;

    controls.target.copy(sphere.center);

    // Frame camera nicely
    const dir = new THREE.Vector3(1, 0.85, 1.3).normalize();
    camera.position.copy(sphere.center).add(dir.multiplyScalar(distance));
    camera.near = radius * 0.01;
    camera.far = radius * 20;
    camera.updateProjectionMatrix();

    controls.update();
}

function disposeObject(obj) {
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
    }
}

// --------------------------------------------------------------------------
// UI & Control Handlers
// --------------------------------------------------------------------------
function bindDomElements() {
    dom.loadingOverlay = document.getElementById('loading-overlay');
    dom.loadingText = document.getElementById('loading-text');

    dom.regionPillContainer = document.getElementById('region-pills');
    dom.selectRegion = document.getElementById('select-region');
    dom.selectLayer = document.getElementById('select-layer');
    dom.selectDisplayMode = document.getElementById('select-display-mode');

    dom.sliderSnowThreshold = document.getElementById('slider-snow-threshold');
    dom.valSnowThreshold = document.getElementById('val-snow-threshold');
    dom.sliderRoughness = document.getElementById('slider-roughness');
    dom.valRoughness = document.getElementById('val-roughness');
    dom.sliderMetalness = document.getElementById('slider-metalness');
    dom.valMetalness = document.getElementById('val-metalness');
    dom.sliderSunElev = document.getElementById('slider-sun-elev');
    dom.valSunElev = document.getElementById('val-sun-elev');
    dom.sliderSunAzimuth = document.getElementById('slider-sun-azimuth');
    dom.valSunAzimuth = document.getElementById('val-sun-azimuth');

    dom.checkSnowActive = document.getElementById('check-snow-active');
    dom.checkSnowIsolate = document.getElementById('check-snow-isolate');
    dom.checkAutorotate = document.getElementById('check-autorotate');
    dom.checkBsrTracks = document.getElementById('check-bsr-tracks');

    dom.btnTimelinePlay = document.getElementById('btn-timeline-play');
    dom.btnExportGlb = document.getElementById('btn-export-glb');
    dom.btnExportObj = document.getElementById('btn-export-obj');
    dom.btnSnapshot = document.getElementById('btn-snapshot');

    dom.modalBackdrop = document.getElementById('info-modal-backdrop');
    dom.btnOpenInfo = document.getElementById('btn-open-info');
    dom.btnCloseModal = document.getElementById('btn-close-modal');

    dom.legendTitle = document.getElementById('legend-title');
    dom.legendBar = document.getElementById('legend-bar');
    dom.legendTicks = document.getElementById('legend-ticks');
    dom.legendCategorical = document.getElementById('legend-categorical');
    dom.legendContinuousWrap = document.getElementById('legend-continuous-wrap');

    dom.legendRegionName = document.getElementById('legend-region-name');
    dom.legendElevRange = document.getElementById('legend-elev-range');
    dom.legendSnowline = document.getElementById('legend-snowline');
    dom.legendSnowArea = document.getElementById('legend-snow-area');
    dom.legendMeshStats = document.getElementById('legend-mesh-stats');
}

function updateLoadingProgress(text) {
    if (dom.loadingText && text) dom.loadingText.textContent = text;
}

function initUI() {
    buildRegionPills();
    populateSelectDropdowns();
    updateLegend();
}

function buildRegionPills() {
    if (!dom.regionPillContainer || !state.manifest || !state.manifest.objects) return;
    dom.regionPillContainer.innerHTML = '';

    state.manifest.objects.forEach((obj) => {
        const btn = document.createElement('button');
        btn.className = `model-pill ${obj.id === state.activeObjectId ? 'active' : ''}`;
        btn.textContent = obj.name;
        btn.addEventListener('click', () => {
            switchModel(obj.id);
        });
        dom.regionPillContainer.appendChild(btn);
    });
}

function updateActivePills() {
    const pills = document.querySelectorAll('.model-pill');
    pills.forEach((p, idx) => {
        const obj = state.manifest.objects[idx];
        if (obj) {
            p.classList.toggle('active', obj.id === state.activeObjectId);
        }
    });
}

function populateSelectDropdowns() {
    if (!state.manifest) return;

    // Region Select
    dom.selectRegion.innerHTML = '';
    state.manifest.objects.forEach((obj) => {
        const opt = document.createElement('option');
        opt.value = obj.id;
        opt.textContent = obj.name;
        dom.selectRegion.appendChild(opt);
    });

    // Layer Select
    dom.selectLayer.innerHTML = '';
    const layers = state.manifest.layers || {};
    const layerKeys = ['elev', 'snow_prob', 'elev_snow', 'cluster', 'anomaly', 'emis', 'eps_refl', 'refl_norm', 'slope'];

    layerKeys.forEach((key) => {
        const lInfo = layers[key] || { title: key };
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = lInfo.title;
        dom.selectLayer.appendChild(opt);
    });

    updateSelectInputs();
}

function updateSelectInputs() {
    if (dom.selectRegion) dom.selectRegion.value = state.activeObjectId;
    if (dom.selectLayer) dom.selectLayer.value = state.activeLayerId;
}

function updateLegend() {
    if (!state.manifest || !state.manifest.layers) return;

    const layerId = state.activeLayerId;
    const lInfo = state.manifest.layers[layerId];

    if (layerId === 'cluster' && lInfo && lInfo.labels && lInfo.colors) {
        dom.legendTitle.textContent = lInfo.title;
        dom.legendContinuousWrap.style.display = 'none';
        dom.legendCategorical.style.display = 'flex';
        dom.legendCategorical.innerHTML = '';

        lInfo.labels.forEach((label, idx) => {
            const col = lInfo.colors[idx] || '#888';
            const item = document.createElement('div');
            item.className = 'legend-cat-item';
            item.innerHTML = `<span class="legend-cat-dot" style="background: ${col};"></span> <span>${label}</span>`;
            dom.legendCategorical.appendChild(item);
        });
    } else {
        dom.legendCategorical.style.display = 'none';
        dom.legendContinuousWrap.style.display = 'flex';

        if (layerId === 'elev_snow') {
            dom.legendTitle.textContent = 'Рельеф + Снежный покров';
            dom.legendBar.style.background = 'linear-gradient(90deg, #1b0f08, #8a4a1c, #c98a3a, #ecc98a, #0284c7, #ffffff)';
            dom.legendTicks.innerHTML = `<span>Низина (-2 км)</span><span>Снеговая линия (hc)</span><span>Вершина (11.3 км)</span>`;
        } else if (lInfo) {
            dom.legendTitle.textContent = lInfo.title;
            const range = lInfo.range || [0, 1];
            const grad = (lInfo.colors || ['#000', '#fff']).join(', ');
            dom.legendBar.style.background = `linear-gradient(90deg, ${grad})`;
            const mid = (range[0] + range[1]) / 2;
            dom.legendTicks.innerHTML = `<span>${range[0].toFixed(1)}</span><span>${mid.toFixed(1)}</span><span>${range[1].toFixed(1)}</span>`;
        }
    }

    // Telemetry
    if (state.activeModelData) {
        const obj = state.activeModelData;
        dom.legendRegionName.textContent = obj.name;

        const hRange = obj.height_range_km || [-2, 11];
        dom.legendElevRange.textContent = `${hRange[0].toFixed(1)} .. ${hRange[1].toFixed(1)} км`;

        dom.legendSnowline.textContent = obj.snowline_km ? `${obj.snowline_km.toFixed(2)} км` : '—';

        const vCount = obj.vertices ? obj.vertices.toLocaleString() : '—';
        const tCount = obj.triangles ? obj.triangles.toLocaleString() : '—';
        dom.legendMeshStats.textContent = `${tCount} / ${vCount}`;
    }
}

function updateSnowMetricsDisplay(threshold) {
    if (!state.activeModelData || !dom.legendSnowArea) return;
    const baseArea = state.activeModelData.snow_area_km2_default || 0;
    const ratio = Math.max(0.05, Math.min(2.5, 1.0 + (0.77 - threshold) * 2.2));
    const estimatedArea = Math.round(baseArea * ratio);
    dom.legendSnowArea.textContent = `${estimatedArea.toLocaleString()} км²`;
}

// --------------------------------------------------------------------------
// Event Listeners & Interactive Handlers
// --------------------------------------------------------------------------
function initEventListeners() {
    // Select Region change
    dom.selectRegion.addEventListener('change', (e) => {
        switchModel(e.target.value);
    });

    // Select Layer change
    dom.selectLayer.addEventListener('change', (e) => {
        applyTextureLayer(e.target.value);
    });

    // Select Display Mode
    dom.selectDisplayMode.addEventListener('change', (e) => {
        state.material.displayMode = e.target.value;
        updateWireframeAndPoints();
    });

    // Snow Threshold Slider (Modifies 3D model in real time!)
    dom.sliderSnowThreshold.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.snowThreshold = val;
        dom.valSnowThreshold.textContent = `${val.toFixed(2)} ${val === 0.77 ? '(Оптимум)' : ''}`;

        // Update shader uniform directly at 60 FPS
        if (state.activeMesh && state.activeMesh.material.userData.shader) {
            state.activeMesh.material.userData.shader.uniforms.uSnowThreshold.value = val;
        }
        updateSnowMetricsDisplay(val);
    });

    // Roughness Slider
    dom.sliderRoughness.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.material.roughness = val;
        dom.valRoughness.textContent = val.toFixed(2);
        if (state.activeMesh) state.activeMesh.material.roughness = val;
    });

    // Metalness Slider
    dom.sliderMetalness.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.material.metalness = val;
        dom.valMetalness.textContent = val.toFixed(2);
        if (state.activeMesh) state.activeMesh.material.metalness = val;
    });

    // Sun Elevation Slider
    dom.sliderSunElev.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.lighting.elevation = val;
        dom.valSunElev.textContent = `${val.toFixed(0)}°`;
        updateSunPosition();
    });

    // Sun Azimuth Timeline Scrubber
    dom.sliderSunAzimuth.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.lighting.azimuth = val;
        dom.valSunAzimuth.textContent = `${val.toFixed(0)}° Азимут Солнца`;
        updateSunPosition();
    });

    // Play / Pause Auto-Rotate
    dom.btnTimelinePlay.addEventListener('click', () => {
        state.camera.autoRotate = !state.camera.autoRotate;
        controls.autoRotate = state.camera.autoRotate;
        dom.checkAutorotate.checked = state.camera.autoRotate;
        dom.btnTimelinePlay.classList.toggle('paused', !state.camera.autoRotate);
    });

    // Checkboxes
    dom.checkSnowActive.addEventListener('change', (e) => {
        state.snowOverlayEnabled = e.target.checked;
        if (state.activeMesh && state.activeMesh.material.userData.shader) {
            state.activeMesh.material.userData.shader.uniforms.uSnowActive.value = state.snowOverlayEnabled ? 1 : 0;
        }
    });

    dom.checkSnowIsolate.addEventListener('change', (e) => {
        state.snowIsolate = e.target.checked;
        if (state.activeMesh && state.activeMesh.material.userData.shader) {
            state.activeMesh.material.userData.shader.uniforms.uSnowIsolate.value = state.snowIsolate ? 1 : 0;
        }
    });

    dom.checkAutorotate.addEventListener('change', (e) => {
        state.camera.autoRotate = e.target.checked;
        controls.autoRotate = state.camera.autoRotate;
        dom.btnTimelinePlay.classList.toggle('paused', !state.camera.autoRotate);
    });

    dom.checkBsrTracks.addEventListener('change', (e) => {
        state.bsrVisible = e.target.checked;
        if (bsrOverlay) bsrOverlay.setVisible(state.bsrVisible);
    });

    // Action Buttons
    dom.btnExportGlb.addEventListener('click', downloadCurrentGLB);
    dom.btnExportObj.addEventListener('click', exportToOBJ);
    dom.btnSnapshot.addEventListener('click', captureSnapshot);

    // Modal
    dom.btnOpenInfo.addEventListener('click', () => dom.modalBackdrop.classList.add('active'));
    dom.btnCloseModal.addEventListener('click', () => dom.modalBackdrop.classList.remove('active'));
    dom.modalBackdrop.addEventListener('click', (e) => {
        if (e.target === dom.modalBackdrop) dom.modalBackdrop.classList.remove('active');
    });
}

// --------------------------------------------------------------------------
// Export Handlers
// --------------------------------------------------------------------------
function downloadCurrentGLB() {
    if (!state.activeModelData) return;
    const glbUrl = `/export_3d/${state.activeModelData.glb}`;
    const a = document.createElement('a');
    a.href = glbUrl;
    a.download = state.activeModelData.glb;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function exportToOBJ() {
    if (!state.activeMesh || !state.activeModelData) {
        alert('Сначала дождитесь загрузки модели.');
        return;
    }

    const exporter = new OBJExporter();
    const modelName = state.activeModelData.id;
    const mtlName = `${modelName}.mtl`;
    const textureName = `${modelName}_${state.activeLayerId}.png`;

    const result = exporter.parse(state.activeMesh, mtlName, textureName);
    OBJExporter.downloadFile(`${modelName}.obj`, result.obj, 'model/obj');

    setTimeout(() => {
        OBJExporter.downloadFile(mtlName, result.mtl, 'model/mtl');
    }, 400);
}

function captureSnapshot() {
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `venus_${state.activeObjectId}_${state.activeLayerId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// --------------------------------------------------------------------------
// Animation Loop & Render
// --------------------------------------------------------------------------
function onWindowResize() {
    const container = document.getElementById('app-viewport');
    const width = container.clientWidth;
    const height = container.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('DOMContentLoaded', initApp);
