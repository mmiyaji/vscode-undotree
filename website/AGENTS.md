# Prototype Instructions

The branching diagram must switch between Japanese and English image variants with the language dropdown; translating alternative text alone is insufficient.

Hero imagery must use a compact actual VS Code window with Undo Tree occupying roughly half the width and visible branching history. Prefer clear branch-point and branch notes over a mostly empty full editor screenshot.

Installation must point to the published Visual Studio Marketplace listing: https://marketplace.visualstudio.com/items?itemName=mmiyaji.vscode-undotree . Use store installation instructions rather than VSIX downloads.

The user changed the selection to the second displayed mock: a documentation-style layout with a fixed left sidebar, compact topbar, full editor screenshot, and tabular features/shortcuts. Retain the existing branching-history diagram and explanatory paragraphs from the first implementation. Use the product name vscode-undotree as the main title. Do not add a catchphrase, promotional slogan, invented statistics, or testimonials. Use actual product screenshots. Provide a Japanese/English dropdown and an icon button for light/dark mode in the topbar. Japanese and dark mode are initial defaults; persist user selections locally.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
