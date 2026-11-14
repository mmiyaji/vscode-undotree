# Design QA

final result: passed

## Target and evidence

- Selected source: D:/AI/Codex/.codex/generated_images/01a1db51-f642-7530-85d1-88ce88bcd173/exec-afd5a725-ec67-4b0c-8fb0-7b709717eb4f.png (revised second displayed mock; 946 × 1663).
- User changes: retain the branching diagram and explanation from the first implementation; add a Japanese/English dropdown and light/dark icon button; use the published Marketplace listing for installation.
- Browser-rendered desktop: qa/desktop-v2.jpg, 1425 × 2671, CSS viewport 1440 × 1000, density 1x excluding 15px scrollbar.
- Browser-rendered mobile: qa/mobile-v2.jpg, 375 × 2526, CSS viewport 390 × 844, density 1x excluding 15px scrollbar.
- Combined source/implementation comparison: qa/comparison-v2.jpg, both normalized to 700px width without aspect-ratio distortion. Source on left, implementation on right.
- Focused header/control comparison: qa/controls-v2.jpg. The dropdown, theme icon, factual title, store button and sidebar are readable.
- Additional state: qa/light-english.jpg and qa/mobile-light-en-v2.jpg show English and light mode. Product captures and diagram preserve original dark image surfaces in light mode.

## Findings and iteration history

1. Initial desktop comparison found P2: the planned sun/moon icon names were unavailable in the selected Codicons package, leaving an empty theme button. Replaced them with the package's color-mode icon.
2. Recaptured desktop and mobile states after the correction. qa/controls-v2.jpg and qa/mobile-light-en-v2.jpg confirm the half-light/half-dark icon is visible. Final combined comparison has no actionable P0/P1/P2 findings.

## Required fidelity surfaces

- Typography: system sans, 36px product heading, 23px section headings, 14–16px body text; no catchphrase. Compact documentation hierarchy follows the second mock.
- Spacing/layout: fixed left contents rail, compact sticky header, full editor image, divided feature rows, shortcut table, numbered installation and footer. The retained diagram and paragraphs replace the mock's plain usage section as explicitly requested. Mobile uses a horizontally scrollable contents bar and a sticky preferences header; the document itself does not overflow.
- Colors: dark charcoal, gray dividers and blue accents follow the mock. Light mode uses white surfaces and dark text with contrast-adjusted blue links; no filters applied to product screenshots.
- Assets: actual logo and editor screenshot, retained generated branching diagram, official VS Code Codicons for UI icons. No placeholder imagery. The full editor image is naturally smaller on phones; it remains illustrative rather than a required reading surface.
- Content: factual bilingual descriptions and shortcut instructions, original diagram retained. Published mmiyaji.vscode-undotree Marketplace page verified and used for both installation links. No VSIX instruction remains in the page.

## Functional verification

- Japanese/English dropdown changes navigation, page copy, control labels and document language.
- Theme icon changes light/dark tokens and its accessible action label.
- Both selections survive reload via local storage; desktop and mobile tested.
- Mobile English/light and Japanese/dark: scrollWidth does not exceed viewport width.
- Keyboard-section navigation reaches #keyboard, with target top 133.8px and matching sidebar active state.
- Marketplace CTA and installation link point to the verified listing; no installation was performed.
- All loaded images rendered; no browser console errors or warnings.
- Production build and four bundled hosting tests passed; git diff --check passed.
- Existing extension tests not rerun because extension source was not changed. No deployment performed.

## Follow-up polish

- P3: retained diagram contains Japanese text in English mode. English alternative text explains the branch relationship.

## Checklist

- [x] Second mock layout and factual title
- [x] Existing branching explanation retained
- [x] Language dropdown and theme icon with saved preferences
- [x] Published Marketplace installation path
- [x] Desktop/mobile and dark/light browser checks
- [x] Combined comparison after visual fix
- [x] Build and hosting checks

## Compact hero revision

- User requested a smaller actual window, a larger extension area, and visible branching. Captured a fresh 903 × 439 VS Code development window in an isolated sample workspace/profile. No existing user editor profile was changed. The capture window was closed after shooting.
- New source asset: public/assets/editor-compact.jpg. Actual native app screenshot; no AI-generated or reconstructed UI. Undo Tree occupies approximately 45% of the window width. Saved checkpoints were created, an earlier checkpoint was revisited, and an alternate edit was saved. Notes identify Branch point, Stable branch and Alternate branch.
- Replaced the hero image and its intrinsic dimensions/alternative text only; retained page layout, explanatory diagram, language/theme controls and Marketplace links.
- Browser evidence: qa/compact-desktop-full.jpg (1425 × 2540), qa/compact-mobile-full.jpg (375 × 2486), viewports 1440 × 1000 and 390 × 844, density 1x excluding scrollbar. qa/compact-preview.jpg is the top-of-page preview.
- Same-input focused comparison: qa/compact-hero-comparison.jpg shows the actual source on top and rendered hero below, normalized to 903px width. No clipping or distortion; branch notes and connecting tree lines are preserved. Existing typography, spacing and color tokens are unchanged. Finite screenshot resolution produces mild softness when scaled above its native size.
- Image loaded at natural size 903 × 439; no document overflow; no console errors/warnings. Production build and git diff --check passed. Hosting tests were not repeated because this revision only replaces a static image and alternative text.
- final result: passed

## Diagram language correction

- Added public/assets/branch-history-en.png, translating every diagram label while retaining the existing paths and colors. The Japanese source remains unchanged.
- The language dropdown now selects the corresponding image source as well as alternative text. Browser checks confirmed both sources load after switching en → ja → en. Evidence: qa/english-diagram.jpg.
- English labels visually inspected: Save 1–5, Edit & save, New branch. This resolves the earlier P3 English-diagram follow-up.
- Production build and git diff --check passed. No layout or extension logic changes.

## Settings guide addition

- Added a bilingual Settings guide and sidebar entry. Content checked against package.json configuration defaults, README_ja.md and the exclusion configuration reader in src/extension.ts.
- Covers extension/file-name tracking, exclusion priority and patterns, array replacement behavior, automatic history persistence, checkpoint interval, extension accent theme and extension language.
- Collapsible workspace settings example is valid JSON; browser parsing confirmed its extensions, file names and persistence mode. It preserves default exclusions by omitting that setting.
- Browser checked English and Japanese copy, opening the example, sidebar navigation and 390px mobile width (no document overflow). No console warnings/errors. Evidence: qa/settings-desktop.jpg and qa/settings-mobile.jpg. Sticky header placement in full-page captures reflects scroll position, not normal document flow.
- Production build and git diff --check passed. Existing extension and hosting tests not repeated for a static documentation section.
- final result: passed

## Cloudflare publication verification

- Published the verified static build (website/dist/client) to Cloudflare Pages project undotree, following SongBrief's direct-upload Pages architecture. Deployment ID: d5918f9f-7dd7-4e68-b8fe-c1218c13854a.
- Attached undotree.ruhenheim.org via the Pages dashboard, which created the CNAME to undotree.pages.dev. HTTPS returned 200 with the expected title after initial DNS verification completed.
- Browser at https://undotree.ruhenheim.org/ confirmed the compact hero and all default images load. English switches to the English branching diagram, light/dark toggles work, and console errors/warnings were empty. Evidence: qa/published-undotree.jpg.
- Production build, all four bundled hosting tests and git diff --check passed before deployment. No application backend is deployed; only the static output is public.
- Added the SongBrief-style GitHub Actions workflow and local Wrangler Pages config. Automatic GitHub deployment remains pending repository secrets and merging the local files to main; this does not affect the initial live deployment.
