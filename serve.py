"""区間セルプレイヤーをローカルで起動する小さな Web サーバー。

使い方: start.bat をダブルクリック（または python serve.py）
メモはブラウザに保存されるため、アドレス（ポート番号）は固定にしている。
"""

import functools
import http.server
import os
import re
import socket
import subprocess
import sys
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT = 8765
URL = f"http://{HOST}:{PORT}/"
MARKER = "区間セルプレイヤー"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows のレジストリ次第で .js が text/plain になるのを避けるため明示する
    extensions_map = {
        "": "application/octet-stream",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/plain; charset=utf-8",
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".ogv": "video/ogg",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".oga": "audio/ogg",
        ".opus": "audio/ogg",
        ".flac": "audio/flac",
    }

    _range_remaining = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    # URL で開いた動画でも途中から再生・シークできるよう Range 要求に対応する
    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m or m.groups() == ("", ""):
            return super().send_head()
        size = os.path.getsize(path)
        start_s, end_s = m.groups()
        if start_s == "":
            start, end = max(0, size - int(end_s)), size - 1
        else:
            start = int(start_s)
            end = min(int(end_s), size - 1) if end_s else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = self._range_remaining
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # 既定の SO_REUSEADDR だと Windows では同じポートに二重に起動できてしまうため、
    # 再利用を切ったうえでポートを占有する
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # 動画のシーク中にブラウザが接続を切るのはよくあることなので黙って無視する
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def find_chrome():
    """Chrome の場所を探す（音声認識などは Chrome 前提のため、既定のブラウザより優先して開く）"""
    if sys.platform == "win32":
        try:
            import winreg

            for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
                    with winreg.OpenKey(root, key) as k:
                        path = winreg.QueryValue(k, None)
                    if path and os.path.isfile(path):
                        return path
                except OSError:
                    pass
        except ImportError:
            pass
        candidates = [
            os.path.join(os.environ.get(v, ""), r"Google\Chrome\Application\chrome.exe")
            for v in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
        ]
    elif sys.platform == "darwin":
        candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:
        candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
    return next((p for p in candidates if p and os.path.isfile(p)), None)


def open_browser():
    chrome = find_chrome()
    if chrome:
        try:
            subprocess.Popen([chrome, URL])
            return
        except OSError:
            pass
    print("Chrome が見つからなかったため、既定のブラウザで開きます（音声認識は Chrome で使えます）。")
    webbrowser.open(URL)


def page_at_port():
    """いまそのポートで動いているページの中身（Web サーバーでなければ None）"""
    try:
        with urllib.request.urlopen(URL, timeout=2) as res:
            return res.read().decode("utf-8", "ignore")
    except Exception:
        return None


def already_running(page):
    return page is not None and MARKER in page


def main():
    want_browser = "--no-browser" not in sys.argv
    try:
        httpd = Server((HOST, PORT), functools.partial(Handler, directory=ROOT))
    except OSError:
        page = page_at_port()
        if already_running(page):
            print(f"すでに起動しています: {URL}")
            if want_browser:
                open_browser()
            return
        # 別のアプリが同じポートを使っている。メモはこのアドレスに保存されているので、ほかのポートには逃げない
        m = re.search(r"<title>([^<]{1,80})</title>", page or "", re.I)
        who = f"「{m.group(1).strip()}」" if m else "別のアプリ"
        print(f"ポート {PORT} を{who}が使っているため、起動できませんでした。")
        print(f"区間セルプレイヤーのメモは {URL} に保存されているので、ほかのポートでは起動しません。")
        print("そのアプリ（そのサーバーを動かしている黒いウィンドウなど）を閉じてから、もう一度 start.bat を起動してください。")
        print(f"(Port {PORT} is used by another app. Close it and run start.bat again.)")
        sys.exit(1)

    print(f"区間セルプレイヤーを起動しました: {URL}")
    print("このウィンドウを閉じると終了します。")
    if want_browser:
        open_browser()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
