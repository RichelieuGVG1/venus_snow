#!/usr/bin/env python3
"""
Vendor Library Downloader (Optional)
------------------------------------
Downloads Three.js, OrbitControls, and GLTFLoader to web/vendor/
for 100% offline usage without external CDN dependency.

Usage:
  python3 download_vendor.py
"""

import os
import urllib.request

VENDOR_DIR = os.path.join(os.path.dirname(__file__), "web", "vendor")
FILES = {
    "three.module.js": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "OrbitControls.js": "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js",
    "GLTFLoader.js": "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js",
    "BufferGeometryUtils.js": "https://unpkg.com/three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js"
}

def main():
    os.makedirs(VENDOR_DIR, exist_ok=True)
    print("=" * 60)
    print("Downloading Three.js offline libraries...")
    print("=" * 60)
    
    for filename, url in FILES.items():
        dest = os.path.join(VENDOR_DIR, filename)
        print(f"Fetching {filename}...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                content = resp.read()
            with open(dest, "wb") as f:
                f.write(content)
            print(f"[OK] Saved {filename} ({round(len(content)/1024, 1)} KB)")
        except Exception as e:
            print(f"[ERROR] Failed {filename}: {e}")
            print("Note: The web app already automatically loads from fast CDNs in the browser.")
            return

    print("\n[OK] Offline vendor bundle complete in web/vendor/!")

if __name__ == "__main__":
    main()

