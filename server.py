"""Serve the prototype, mapping /topic/{topic} to topic.html."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/topic/"):
            self.path = "/topic.html"
        elif path == "/":
            self.path = "/index.html"
        super().do_GET()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
