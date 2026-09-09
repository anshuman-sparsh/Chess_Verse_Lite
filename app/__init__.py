import os

from flask import Flask

from .routes import bp


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder="../",
        static_folder="../static",
    )

    app.config["JSON_SORT_KEYS"] = False
    if os.environ.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = os.environ["SECRET_KEY"]

    app.register_blueprint(bp)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self'; connect-src 'self'; "
            "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        return response

    return app

