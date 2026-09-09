# Chess Verse Lite

Chess Verse Lite is a lightweight, responsive chess game reviewer. PGN parsing and Stockfish analysis run locally in the browser; no game data is sent to an analysis server.

Live app: [chess-verse-lite.vercel.app](https://chess-verse-lite.vercel.app/)

## Features

- Load standard PGNs or games that use `SetUp` and `FEN` headers.
- Review every mainline move with a reusable Web Worker running bundled Stockfish.
- Compare White/Black accuracy and inspect move classifications, best moves, and principal variations.
- Explore variations in Practice Mode using click-to-move or drag-and-drop, including underpromotion choices.
- Use keyboard navigation and a responsive dark/glassmorphic interface.

## Analysis semantics

Engine scores are stored as tagged values instead of overloading large centipawn numbers:

- `{ type: "cp", whitePovCp }`
- `{ type: "mate", winner, moves }`
- `{ type: "terminal", result: "draw" }`

Centipawn scores are normalized to White's point of view exactly once when Stockfish output is parsed. The displayed evaluation bar is also White POV.

Win probability uses the logistic function below, with centipawns clamped to `[-1000, 1000]` for numerical stability:

```text
Wwhite(cp) = 100 / (1 + exp(-0.00368208 * cp))
```

For each move, both before/after probabilities are converted to the mover's point of view. Win-probability loss is `max(0, Wbefore - Wafter)`. Per-move accuracy is:

```text
accuracy = 100 * exp(-0.035 * winProbabilityLoss)
```

Both values are clamped to `[0, 100]`. Player accuracy is the arithmetic mean of all available moves by that player, including short games. If a side made no move, its value is shown as unavailable rather than `0%`.

Classifications use mover-POV win-probability loss: Best `<= 0.5`, Excellent `<= 1.5`, Good `<= 3`, Inaccuracy `<= 7`, Mistake `<= 15`, and Blunder above `15` percentage points. The exact engine move is always Best unless stronger, independently verified evidence exists. A Miss requires a failed decisive opportunity (or losing a forced mate), not merely a large ordinary loss. Book is emitted only from explicit book evidence. Great and Brilliant require evidence fields for uniqueness/non-obviousness or a sound persistent sacrifice; the current single-PV analyzer intentionally does not invent that evidence, so it conservatively avoids those labels.

These formulas are application heuristics, not official Chess.com or Lichess formulas. Changing them will change historical accuracy and classification output.

## Safety and limits

- One Stockfish worker is reused across searches.
- Reset, mode switch, cancellation, or a new game invalidates the current analysis session.
- Searches have readiness, search, and stop-drain timeouts. A worker that cannot stop cleanly is replaced.
- Only exact primary-PV scores are accepted; bound scores and other MultiPV lines are ignored.
- PGN input is limited to 100,000 characters and games to 400 plies to protect low-memory/mobile devices.

## Run locally

Opening `index.html` directly may be blocked by browser Worker/WASM security rules. Serving the directory over HTTP is recommended:

```bash
python -m pip install -r requirements.txt
python run.py
```

Then open `http://localhost:5000`.

To explicitly enable Flask's development debugger, set `FLASK_DEBUG=1` in your local environment. Do not enable it in production.

## Tests

Node.js 18 or newer is sufficient; there are no npm runtime dependencies.

```bash
npm test
```

The regression suite covers chess.js PGN/FEN parsing, special moves, tagged score math, mover perspective, short games, mate/Miss behavior, conservative classification evidence, UCI readiness, worker reuse, cancellation, session changes, stale responses, and timeout recovery.

## Deployment

The included Vercel configuration adds baseline browser security headers. Stockfish remains client-side. There is no Gemini or AI Coach implementation in this version.
