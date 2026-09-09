import os

from app import create_app


app = create_app()


if __name__ == "__main__":
    # For local development only. In production, run via a WSGI server.
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("CHESS_VERSE_PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )

