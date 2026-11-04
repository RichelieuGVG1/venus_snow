#!/usr/bin/env python3
"""
Venus 3D Interactive Web Server
--------------------------------
Serves the Three.js 3D Atlas of Venus, Magellan radar data, ML metallic snow
classification, and regional topography models.

Zero external dependencies - uses standard library Python 3.
Supports:
  - Range requests for large binary GLB streaming (HTTP 206 Partial Content)
  - Multithreaded request handling
  - Automatic port failover if 8000 is occupied
  - Immediate, graceful shutdown on Ctrl+C / Cmd+C (SIGINT / SIGTERM)
  - REST API endpoints for manifest, summary, regions, and bsr tracks
  - Direct downloads of GLB, textures, and export packages

Usage:
  python3 app.py [--port 8000] [--host 0.0.0.0] [--open]
"""

import argparse
import json
import mimetypes
import os
import posixpath
import re
import signal
import socketserver
import sys
import threading
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Base paths
ROOT_DIR = os.path.abspath(os.path.dirname(__file__))
# The website/ directory IS our web root - serve HTML/CSS/JS from here
WEB_DIR = ROOT_DIR
# Results and export_3d are in the sibling venus_snow/ directory
PROJECT_DIR = os.path.dirname(ROOT_DIR)
VENUS_DATA_DIR = os.path.join(PROJECT_DIR, "venus_snow")
RESULTS_DIR = os.path.join(VENUS_DATA_DIR, "results")
EXPORT_3D_DIR = os.path.join(RESULTS_DIR, "export_3d")
MANIFEST_PATH = os.path.join(EXPORT_3D_DIR, "manifest.json")
SUMMARY_PATH = os.path.join(RESULTS_DIR, "summary.json")
BSR_TRACKS_PATH = os.path.join(EXPORT_3D_DIR, "bsr_tracks.json")

# Ensure proper MIME types for 3D & web formats
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("model/obj", ".obj")
mimetypes.add_type("model/mtl", ".mtl")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/csv", ".csv")


class ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """Multithreaded server to handle concurrent texture and mesh requests."""
    daemon_threads = True
    allow_reuse_address = True


class VenusAtlasHandler(SimpleHTTPRequestHandler):
    """Custom HTTP handler with Range request support, CORS, and API routes."""

    server_version = "Venus3DServer/2.0"

    def end_headers(self):
        # Enable CORS and caching headers
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path

        # API Endpoints
        if clean_path == "/api/manifest":
            return self.serve_json_file(MANIFEST_PATH)
        if clean_path == "/api/summary":
            return self.serve_json_file(SUMMARY_PATH)
        if clean_path == "/api/bsr":
            return self.serve_json_file(BSR_TRACKS_PATH)
        if clean_path == "/api/status":
            return self.serve_status()
        if clean_path == "/api/regions":
            return self.serve_regions_api()

        # Map URLs to filesystem paths
        file_path = self.resolve_file_path(clean_path)
        if file_path and os.path.isfile(file_path):
            return self.serve_file_with_range(file_path)

        # Fallback to index.html for root or missing routes
        if clean_path == "/" or clean_path == "/index.html":
            index_path = os.path.join(WEB_DIR, "index.html")
            if os.path.isfile(index_path):
                return self.serve_file_with_range(index_path)

        # 404
        self.send_error(HTTPStatus.NOT_FOUND, f"File not found: {clean_path}")

    def resolve_file_path(self, clean_path):
        """Resolves request path to local file path safely."""
        clean_path = posixpath.normpath(urllib.parse.unquote(clean_path)).lstrip("/")

        # Check in web/ directory first (website/ root)
        candidate = os.path.join(WEB_DIR, clean_path)
        if os.path.isfile(candidate):
            return candidate

        # Direct mapping for vendor/ JS libs
        if clean_path.startswith("vendor/"):
            candidate = os.path.join(WEB_DIR, clean_path)
            if os.path.isfile(candidate):
                return candidate

        # Check export_3d/ alias -> points to venus_snow/results/export_3d/
        if clean_path.startswith("export_3d/"):
            sub = clean_path[len("export_3d/"):]
            candidate = os.path.join(EXPORT_3D_DIR, sub)
            if os.path.isfile(candidate):
                return candidate

        # Check results/ path
        if clean_path.startswith("results/"):
            sub = clean_path[len("results/"):]
            candidate = os.path.join(RESULTS_DIR, sub)
            if os.path.isfile(candidate):
                return candidate

        # Check figures/ path
        if clean_path.startswith("figures/"):
            candidate = os.path.join(VENUS_DATA_DIR, clean_path)
            if os.path.isfile(candidate):
                return candidate

        return None

    def serve_json_file(self, path):
        """Reads and sends JSON response."""
        if not os.path.isfile(path):
            self.send_error(HTTPStatus.NOT_FOUND, f"JSON file missing: {os.path.basename(path)}")
            return
        try:
            with open(path, "rb") as f:
                content = f.read()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error reading JSON: {str(e)}")

    def serve_status(self):
        """Returns server health, loaded model inventory and stats."""
        status = {
            "status": "online",
            "server": "Venus 3D Interactive Atlas Backend",
            "models_ready": os.path.isdir(EXPORT_3D_DIR),
            "manifest_found": os.path.isfile(MANIFEST_PATH),
            "summary_found": os.path.isfile(SUMMARY_PATH),
            "root_dir": ROOT_DIR,
            "export_3d_dir": EXPORT_3D_DIR,
            "models": []
        }
        if os.path.isdir(EXPORT_3D_DIR):
            for fname in sorted(os.listdir(EXPORT_3D_DIR)):
                if fname.endswith(".glb"):
                    fpath = os.path.join(EXPORT_3D_DIR, fname)
                    status["models"].append({
                        "filename": fname,
                        "size_mb": round(os.path.getsize(fpath) / (1024 * 1024), 2)
                    })
        body = json.dumps(status, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_regions_api(self):
        """Merges manifest objects with summary metrics for quick frontend access."""
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            summary = {}
            if os.path.isfile(SUMMARY_PATH):
                with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
                    summary = json.load(f)

            regions_snowline = {item["регион"]: item for item in summary.get("snowline_by_region", [])}

            combined_objects = []
            for obj in manifest.get("objects", []):
                obj_copy = dict(obj)
                name = obj.get("name")
                if name in regions_snowline:
                    obj_copy["snowline_metrics"] = regions_snowline[name]
                combined_objects.append(obj_copy)

            resp_data = {
                "title": manifest.get("title"),
                "coordinate_system": manifest.get("coordinate_system"),
                "snow": manifest.get("snow"),
                "layers": manifest.get("layers"),
                "objects": combined_objects,
                "clustering": summary.get("clustering"),
                "global_metrics": summary.get("snow")
            }
            body = json.dumps(resp_data, indent=2, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error building regions API: {str(e)}")

    def serve_file_with_range(self, filepath):
        """Serves a file supporting Range headers for fast GLB streaming."""
        try:
            filesize = os.path.getsize(filepath)
            ctype, _ = mimetypes.guess_type(filepath)
            if not ctype:
                ctype = "application/octet-stream"

            range_header = self.headers.get("Range")
            if range_header:
                match = re.match(r"bytes=(\d+)-(\d*)", range_header)
                if match:
                    start = int(match.group(1))
                    end_str = match.group(2)
                    end = int(end_str) if end_str else filesize - 1
                    end = min(end, filesize - 1)
                    if start <= end and start < filesize:
                        length = end - start + 1
                        self.send_response(HTTPStatus.PARTIAL_CONTENT)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{filesize}")
                        self.send_header("Content-Length", str(length))
                        self.send_header("Accept-Ranges", "bytes")
                        self.end_headers()
                        with open(filepath, "rb") as f:
                            f.seek(start)
                            self.copy_chunked(f, self.wfile, length)
                        return
                    else:
                        self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(filesize))
            self.send_header("Accept-Ranges", "bytes")
            if filepath.endswith((".glb", ".zip")):
                self.send_header("Cache-Control", "public, max-age=86400")
            elif filepath.endswith(".png"):
                self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()

            with open(filepath, "rb") as f:
                self.copy_chunked(f, self.wfile, filesize)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Error serving file: {str(e)}")

    @staticmethod
    def copy_chunked(source, dest, length, chunk_size=64 * 1024):
        """Copies length bytes in chunks."""
        remaining = length
        while remaining > 0:
            read_size = min(chunk_size, remaining)
            buf = source.read(read_size)
            if not buf:
                break
            dest.write(buf)
            remaining -= len(buf)


def find_free_port(start_port=8000, max_attempts=50):
    """Finds an available port starting from start_port."""
    import socket
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("", port))
                return port
            except OSError:
                continue
    return start_port


def main():
    parser = argparse.ArgumentParser(description="Venus 3D Interactive Web Server")
    parser.add_argument("--port", type=int, default=8000, help="Port to serve on (default: 8000)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host address (default: 0.0.0.0)")
    parser.add_argument("--open", action="store_true", help="Automatically open browser on launch")
    args = parser.parse_args()

    port = args.port
    actual_port = find_free_port(port)

    server_address = (args.host, actual_port)
    httpd = ThreadedHTTPServer(server_address, VenusAtlasHandler)

    # Set up instant SIGINT (Ctrl+C / Cmd+C) signal handler
    def shutdown_handler(signum, frame):
        print("\nStopping server...")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    url_local = f"http://localhost:{actual_port}"
    print("=" * 66)
    print("  VENUS 3D ATLAS // INTERACTIVE VISUALIZER & EXPORTER")
    print(f"  Server running at: {url_local}")
    print(f"  Models directory:  {EXPORT_3D_DIR}")
    print(f"  Web frontend:      {WEB_DIR}/index.html")
    print("  Press Ctrl+C (Command+C) to stop the server")
    print("=" * 66)

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url_local)).start()

    try:
        # poll_interval=0.5 ensures signals like Ctrl+C are caught instantly
        httpd.serve_forever(poll_interval=0.5)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        print("\nServer gracefully stopped.")
        try:
            httpd.server_close()
        except Exception:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
