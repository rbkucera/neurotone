# Neurotone

Neurotone is a browser-based binaural beat and soundscape editor with:
- Timeline-first session design
- Segment-level overrides and automation lanes
- Analysis mode for focused segment tuning
- Visualizer mode with multiple rendering styles

## Tech Stack

- TypeScript
- Vite
- Web Audio API
- PixiJS v8 (with compatibility fallback renderer)

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Scripts

```bash
npm run dev      # start local dev server
npm run build    # typecheck + production build
npm run preview  # preview production build
npm test         # run test suite
```

## Build Base Path

This app is configured with:

- `base: '/neurotone/'` in [`vite.config.ts`](/Users/ryan/Desktop/beats_app/vite.config.ts)

That makes production assets resolve correctly when hosted under a `/neurotone/` subpath (for example on GitHub Pages under a repo site path).

## Project Structure

- [`src/app.ts`](/Users/ryan/Desktop/beats_app/src/app.ts): app UI orchestration and mode routing
- [`src/audio/`](/Users/ryan/Desktop/beats_app/src/audio): Web Audio engine and audio diagnostics helpers
- [`src/sequencer/`](/Users/ryan/Desktop/beats_app/src/sequencer): session playback model and timeline resolution
- [`src/composer/`](/Users/ryan/Desktop/beats_app/src/composer): note/chord composer and timeline generation
- [`src/visualizers/`](/Users/ryan/Desktop/beats_app/src/visualizers): visualizer registry, signal synthesis, and band activity logic

## Notes

- Share URLs are compact v5 hash payloads.
- Visualizer runtime exposes debug state at `window.__neurotoneViz`.
- If Pixi initialization fails, Neurotone automatically falls back to compatibility rendering.
