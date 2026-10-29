"""Serve the prototype, mapping /topic/{topic} to topic.html."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.startswith("/topic/"):
            # keep any other parameters, such as quality=authoritative
            location = "/topic.html?topic=" + path.split("/")[2]
            self.send_response(302)
            self.send_header("Location", location + ("&" + query if query else ""))
            self.end_headers()
            return
        elif path == "/":
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        # check with the server every time, so changed files show without a hard refresh
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
