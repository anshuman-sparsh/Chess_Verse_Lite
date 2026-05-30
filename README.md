# Chess Verse Lite 👑

A beautiful, interactive chess game review and analysis web application. Load your chess games, see how accurate your moves were, and analyze positions directly in your web browser.

🔗 **[Play & Analyze Now (Live Link)](https://chess-verse-lite.vercel.app/)**

---

## 🌟 What is this?

**Chess Verse Lite** is a lightweight, high-performance chess analysis tool that runs entirely in your web browser. Whether you want to review your recent online chess games, study specific positions, or practice against an engine, Chess Verse Lite makes it easy without needing any downloads or server setup.

---

## ✨ Features

- **Instant Game Analysis**: Paste your PGN (Portable Game Notation) games to get move-by-move evaluation and accuracy grading.
- **Built-in Chess Engine**: Powered by the Stockfish chess engine running directly inside your browser via WebAssembly (WASM).
- **Interactive Evaluation Curve**: View a real-time graph showing who is winning and how the game balance shifted.
- **Review & Analyze Modes**: Step through full games at your own pace or play moves on the board dynamically.
- **Sleek Modern Design**: A clean, dark-themed responsive interface optimized for both desktop and mobile devices.

---

## 🚀 How to Use

1. **Open the App**: Click the [Live Link](https://chess-verse-lite.vercel.app/) to launch the app.
2. **Load your Game**: Copy your chess game's PGN from websites like Chess.com or Lichess, paste it into the input area, and click **Analyze**.
3. **Explore Moves**: Use the control buttons (Next, Previous, Play) to step through your game.
4. **See Evaluations**: Watch the evaluation bar and game progress graph update in real-time to see your best moves and blunders!

---

## 💻 How to Run Locally

If you want to run the project on your own computer, you have two options:

### Option 1: Double-Click (Simplest)
Since Chess Verse Lite runs entirely in your browser, you can simply clone/download this repository and open the `index.html` file in any modern web browser.

### Option 2: Run with Python Flask Server
If you prefer to run it using a local development server:

1. Make sure you have Python installed.
2. Install the required Python packages:
   ```bash
   pip install -r requirements.txt
   ```
3. Run the application:
   ```bash
   python run.py
   ```
4. Open your web browser and go to `http://localhost:5000`.
