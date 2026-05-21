# Chess_Verse_Lite 👑

A beautiful, high-performance, client-side chess review and analysis application. Execute complete game reports and practice positions with an embedded Stockfish engine running inside your browser via WebAssembly (WASM).

This project has been migrated to run completely client-side, making it **100% compatible with static hosting platforms like Vercel**. No backend executable or server configuration is required.

---

## ⚡ Key Features

* **WASM Stockfish Integration**: Runs Stockfish v10.0.2 directly in the browser via a Web Worker.
* **Accuracy Grading**: Real-time evaluation curves and game accuracy scores calibrated with Chess.com's algorithms.
* **Review & Practice Modes**: Stepping controls for reviewing full game PGNs, and a mobile-friendly click-to-move Practice Mode.
* **Zero Infrastructure Cost**: Client-side execution means you can host it for free and scale to millions of users.

---


### Using the Included Flask Runner:
If you want to use the local Python runner:
1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Run the development server:
   ```bash
   python run.py
   ```
3. Open `http://localhost:5000/`.

---

## 🛠️ Project Structure

* **`index.html`**: Main single-page application markup.
* **`static/js/app.js`**: Core client-side coordinator, Web Worker integration, win probability calculations, and UI event listeners.
* **`static/css/style.css`**: CSS styling including custom variables, dark glassmorphism design tokens, and media query responsiveness.
* **`static/js/stockfish.wasm.js` & `stockfish.wasm`**: Stockfish engine compiled for WebAssembly.
