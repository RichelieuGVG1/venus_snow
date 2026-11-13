/**
 * BSR (Bistatic Radar) Orbital Tracks Overlay
 * -------------------------------------------
 * Visualizes Magellan spacecraft Bistatic Radar tracks across Venus
 * with surface conductivity proxy (m_c) mapped to color.
 *
 * Project: Venus Metallic Snow & Surface Types
 * Author: Guryanov
 */

export class BSROverlay {
    /**
     * @param {THREE} THREE 
     * @param {Object} [options]
     */
    constructor(THREE, options = {}) {
        this.THREE = THREE;
        this.tracksData = null;
        this.group = new THREE.Group();
        this.group.name = 'bsr_tracks_overlay';
        this.visible = false;
        this.radius = options.radius || 1.008; // used only when no surface function is set
        // Height of the tracks above the relief (in globe radii) to avoid z-fighting
        this.lift = options.lift || 0.0012;
        // Max angular step between samples, degrees: segments follow the relief
        this.sampleStepDeg = options.sampleStepDeg || 0.1;
        // (latDeg, lonDeg) => radius of the relief surface; null = plain sphere
        this.surfaceRadius = null;
    }

    /**
     * Loads the BSR tracks JSON from the API or local file.
     * @param {string} [url='/api/bsr']
     */
    async load(url = '/data/bsr.json') {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this.tracksData = await resp.json();
            this.buildGeometry();
            return this.tracksData;
        } catch (err) {
            console.warn('Failed to load BSR tracks:', err);
            return null;
        }
    }

    /**
     * Sets the function that returns the relief radius at (lat, lon) and
     * rebuilds the tracks so they lie on the current relief.
     * @param {(latDeg: number, lonDeg: number) => number} fn
     */
    setSurfaceFunction(fn) {
        this.surfaceRadius = fn;
        this.buildGeometry();
    }

    /** Point on the relief (or on the plain sphere) lifted by `extra`. */
    surfacePoint(latDeg, lonDeg, extra = 0) {
        const r = this.surfaceRadius
            ? this.surfaceRadius(latDeg, lonDeg) + this.lift + extra
            : this.radius + extra;
        return this.latLonToVector3(latDeg, lonDeg, r);
    }

    /**
     * Densified path between two track points: interpolates along the great
     * circle and puts every sample on the relief, so a segment never cuts
     * through mountains.
     */
    samplePath(lat0, lon0, lat1, lon1, out) {
        const a = this.latLonToVector3(lat0, lon0, 1);
        const b = this.latLonToVector3(lat1, lon1, 1);
        const angle = a.angleTo(b) * 180 / Math.PI;
        const n = Math.max(1, Math.ceil(angle / this.sampleStepDeg));
        const v = new this.THREE.Vector3();
        for (let k = out.length ? 1 : 0; k <= n; k++) {
            const t = k / n;
            // Spherical linear interpolation of the unit vectors
            const s = Math.sin(a.angleTo(b));
            if (s < 1e-9) {
                v.copy(a);
            } else {
                const w = a.angleTo(b);
                v.copy(a).multiplyScalar(Math.sin((1 - t) * w) / s)
                    .addScaledVector(b, Math.sin(t * w) / s);
            }
            const lat = Math.asin(Math.max(-1, Math.min(1, v.y))) * 180 / Math.PI;
            const lon = Math.atan2(-v.z, v.x) * 180 / Math.PI;
            out.push(this.surfacePoint(lat, lon));
        }
    }

    /**
     * Converts (lat, lon) in degrees to Cartesian coords on unit sphere.
     * glTF convention: +X -> (0°N, 0°E), +Y -> North pole.
     */
    latLonToVector3(latDeg, lonDeg, r = this.radius) {
        const phi = (latDeg * Math.PI) / 180;
        const theta = (lonDeg * Math.PI) / 180;

        const y = r * Math.sin(phi);
        const cosPhi = Math.cos(phi);
        // Longitude +X -> (0°E), -Z -> (90°E) in right-handed Three.js system
        const x = r * cosPhi * Math.cos(theta);
        const z = -r * cosPhi * Math.sin(theta);

        return new this.THREE.Vector3(x, y, z);
    }

    /**
     * Interpolates color based on conductivity value m_c (0.0 to 1.0).
     */
    getConductivityColor(mc) {
        // High m_c corresponds to high dielectric / metallic behavior
        // Gradient: Deep Purple -> Cyan -> Bright Yellow
        const val = Math.max(0, Math.min(1, mc));
        const color = new this.THREE.Color();
        if (val < 0.25) {
            color.setHSL(0.65, 0.9, 0.45 + val);
        } else if (val < 0.6) {
            const t = (val - 0.25) / 0.35;
            color.lerpColors(new this.THREE.Color(0x00d2ff), new this.THREE.Color(0x00ff88), t);
        } else {
            const t = (val - 0.6) / 0.4;
            color.lerpColors(new this.THREE.Color(0x00ff88), new this.THREE.Color(0xffe600), t);
        }
        return color;
    }

    buildGeometry() {
        if (!this.tracksData || !Array.isArray(this.tracksData)) return;

        // Clear existing children
        while (this.group.children.length > 0) {
            const obj = this.group.children[0];
            this.group.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        }

        this.tracksData.forEach((track, trackIdx) => {
            const lats = track.lat || [];
            const lons = track.lon || [];
            const mcs = track.m_c || [];
            const count = Math.min(lats.length, lons.length, mcs.length);

            if (count < 2) return;

            const points = [];
            const colors = [];
            const path = [];

            for (let i = 0; i < count; i++) {
                // Markers sit slightly higher than the line
                points.push(this.surfacePoint(lats[i], lons[i], this.lift));
                const col = this.getConductivityColor(mcs[i]);
                colors.push(col.r, col.g, col.b);
                if (i > 0) this.samplePath(lats[i - 1], lons[i - 1], lats[i], lons[i], path);
            }

            // 1. Trajectory line draped over the relief
            const lineGeo = new this.THREE.BufferGeometry().setFromPoints(path);
            const lineMat = new this.THREE.LineBasicMaterial({
                color: 0x4fa3e3,
                transparent: true,
                opacity: 0.9
            });
            const line = new this.THREE.Line(lineGeo, lineMat);
            line.renderOrder = 4;
            this.group.add(line);

            // 2. Draw measurement points with color based on m_c
            const ptsGeo = new this.THREE.BufferGeometry().setFromPoints(points);
            ptsGeo.setAttribute('color', new this.THREE.Float32BufferAttribute(colors, 3));

            const ptsMat = new this.THREE.PointsMaterial({
                size: 0.022,
                vertexColors: true,
                transparent: true,
                opacity: 0.95
            });
            const pCloud = new this.THREE.Points(ptsGeo, ptsMat);
            pCloud.userData = { orbit: track.orbit, pointsCount: count };
            this.group.add(pCloud);
        });

        this.group.visible = this.visible;
    }

    setVisible(show) {
        this.visible = show;
        this.group.visible = show;
    }

    toggle() {
        this.setVisible(!this.visible);
        return this.visible;
    }
}