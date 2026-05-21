import os

from flask import Flask

from .routes import bp


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder="../",
        static_folder="../static",
    )

    # Basic, production-friendly defaults.
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev-secret-change-me"),
        JSON_SORT_KEYS=False,
    )

    app.register_blueprint(bp)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    return app

