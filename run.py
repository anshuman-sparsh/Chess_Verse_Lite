from app import create_app


app = create_app()


if __name__ == "__main__":
    # For local development only. In production, run via a WSGI server.
    app.run(host="0.0.0.0", port=5000, debug=True)

