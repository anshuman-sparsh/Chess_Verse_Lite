from flask import Blueprint, jsonify, render_template

bp = Blueprint("main", __name__)


@bp.get("/")
def home():
    return render_template("index.html")


@bp.post("/analyze")
def analyze():
    return jsonify({
        "ok": False,
        "error": "Backend analysis is deprecated. Stockfish engine runs client-side in the browser."
    }), 501


@bp.get("/analyze_position")
def analyze_position():
    return jsonify({
        "ok": False,
        "error": "Backend position analysis is deprecated. Stockfish engine runs client-side in the browser."
    }), 501
