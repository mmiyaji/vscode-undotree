# Prototype Instructions

Use only mmiyaji as the provider name in legal-page body text, in both Japanese and English.

Show actual Diff and notes/pins screenshots with concrete usage steps and full-size image links. Switch the actual screenshot assets and full-size links between Japanese and English UI with the site's language control, including translated checkpoint notes. Translating captions alone is insufficient. Keep the existing branching explanation and compact hero.

Demo screenshots must contain realistic, readable code, not long repeated dummy strings. Use a compact actual VS Code window with purposeful changes such as stock filtering, price sorting, and currency formatting in products.ts. Keep captions and checkpoint notes consistent with the screenshot.

Keep Terms of Use (/terms), Privacy Policy (/privacy), and the author's website (https://ruhenheim.org/) linked from the footer. Legal pages must support the same language and theme controls. Describe actual extension storage behavior, including persisted unsaved edits and workspace-scoped deletion; do not add conditions that restrict the MIT License.

The language switcher follows the user's globe-button reference: show the selected language and a small chevron in a bordered button; open a right-aligned rounded menu below it with Japanese and English rows, a blue vertical indicator beside the selected language, and a subtle shadow. Support both site themes, outside-click/Escape dismissal, keyboard selection, and saved language preference.

The branching diagram must switch between Japanese and English image variants with the language dropdown; translating alternative text alone is insufficient.

Hero imagery must use a compact actual VS Code window with Undo Tree occupying roughly half the width and visible branching history. Prefer clear branch-point and branch notes over a mostly empty full editor screenshot.

Installation must point to the published Visual Studio Marketplace listing: https://marketplace.visualstudio.com/items?itemName=mmiyaji.vscode-undotree . Use store installation instructions rather than VSIX downloads.

The user changed the selection to the second displayed mock: a documentation-style layout with a fixed left sidebar, compact topbar, full editor screenshot, and tabular features/shortcuts. Retain the existing branching-history diagram and explanatory paragraphs from the first implementation. Use the product name vscode-undotree as the main title. Do not add a catchphrase, promotional slogan, invented statistics, or testimonials. Use actual product screenshots. Provide a Japanese/English dropdown and an icon button for light/dark mode in the topbar. Japanese is the initial language. The initial theme follows the system preference; persist explicit user selections locally.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
