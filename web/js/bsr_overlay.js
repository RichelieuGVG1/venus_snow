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
        this.radius = options.radius || 1.008; // slightly above sphere to avoid z-fighting
    }

    /**
     * Loads the BSR tracks JSON from the API or local file.
     * @param {string} [url='/api/bsr']
     */
    async load(url = '/api/bsr') {
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

            for (let i = 0; i < count; i++) {
                const vec = this.latLonToVector3(lats[i], lons[i]);
                points.push(vec);
                const col = this.getConductivityColor(mcs[i]);
                colors.push(col.r, col.g, col.b);
            }

            // 1. Draw smooth trajectory line
            const curve = new this.THREE.CatmullRomCurve3(points);
            const tubePoints = curve.getPoints(points.length * 2);
            const lineGeo = new this.THREE.BufferGeometry().setFromPoints(tubePoints);
            const lineMat = new this.THREE.LineBasicMaterial({
                color: 0x4fa3e3,
                transparent: true,
                opacity: 0.65,
                linewidth: 1.5
            });
            const line = new this.THREE.Line(lineGeo, lineMat);
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

