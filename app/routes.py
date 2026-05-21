import io
import logging
from typing import Any, Dict, List, Optional

import chess
import chess.engine
import chess.pgn
from flask import Blueprint, jsonify, render_template, request

logger = logging.getLogger(__name__)

bp = Blueprint("main", __name__)


def _parse_first_pgn_game(pgn_text: str) -> chess.pgn.Game:
    """
    Parse a PGN string and return the first game found.
    """
    pgn_io = io.StringIO(pgn_text)
    game = chess.pgn.read_game(pgn_io)
    if game is None:
        raise ValueError("No PGN game found. Please provide a valid PGN.")
    return game


def _pgn_to_mainline_san(game: chess.pgn.Game) -> List[str]:
    board = game.board()
    san_moves: List[str] = []

    for move in game.mainline_moves():
        if move not in board.legal_moves:
            raise ValueError("PGN contains illegal or inconsistent moves.")
        san_moves.append(board.san(move))
        board.push(move)

    return san_moves


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
