# Language menu design QA

final result: passed

## Scope and visual target

- Scoped replacement of the existing language select; the page layout, content, image assets, language persistence and theme controls are preserved.
- Source: `C:/Users/mail/AppData/Local/Temp/codex-clipboard-f81dbd72-de20-40a2-b913-b4c3685bf116.png` (195 × 161 px).
- Preview: http://127.0.0.1:5173/
- Browser: Codex in-app browser.
- Desktop viewport: 1028 × 883 CSS px; component capture: 195 × 161 px, native screenshot scale 1.
- Mobile viewport and native screenshot: 375 × 812 CSS px / px.
- Compared state: Japanese selected, popup expanded, light theme. A dark-theme variant was also checked.

## Evidence

Screenshots are in `D:/AI/Codex/.codex/visualizations/2026/11/14/01a1db51-f642-7530-85d1-88ce88bcd173/`:

- `language-menu-light.png`: normalized component comparison.
- `language-menu-dark.png`: dark-theme component.
- `language-menu-context.png`: desktop page context, 1028 × 420 px.
- `language-menu-mobile.png`: responsive layout, 375 × 812 px.

The source and normalized implementation images were opened together in one comparison tool call. No image compositing or re-creation was used. The focused component is the full supplied visual target; the additional desktop context verifies its integration with the existing page.

## Comparison history

1. Initial inspection found a gray hover background on the expanded light-theme trigger, unlike the white reference button (P2). Added an expanded-state background rule; the initial observation is visible in the browser screenshot in this chat.
2. Compared the source and revised native component capture at equal dimensions. The open trigger is white, the popup aligns to its right edge, and the selected blue bar, two rows, globe, chevron, border, radius and shadow match the reference structure. No remaining actionable P0/P1/P2 findings.

## Fidelity surfaces

- Typography: existing Segoe UI / Japanese system fallbacks; 13 px semibold trigger and 14 px normal options. Labels match the source exactly. The trigger is 101 px wide versus approximately 98 px in the source, reflecting the existing site font metrics; this small difference is accepted.
- Spacing: 36 px trigger height, 4 px gap, 140 × 88 px popup, 38 px rows, 8 px popup radius. Selected marker is 3 × 14 px. No clipped text or controls.
- Colors: white popup and trigger in light mode; the selected marker uses the site's existing blue token. Dark mode uses existing dark control, foreground and border tokens. The site's header border behind the popup is intentional surrounding context absent from the source crop.
- Assets: existing Codicons globe and chevron icons; no generated raster assets, custom SVG icons or substitute glyph drawings.
- Content: Japanese and English labels only; current selection remains explicit. Existing page copy and translated branch images are preserved.

## Functional verification

- Mouse selection changes the page language and closes the popup.
- English uses `branch-history-en.png`; Japanese uses `branch-history.png`.
- The selected language survives reload.
- Arrow keys open/navigate the list; Home and Enter select Japanese.
- Escape closes the list and returns focus to the trigger.
- Clicking outside closes the list.
- Tab closes the list and moves to the theme control.
- Both light and dark expanded states render correctly.
- At 375 px, the menu remains inside the viewport (left 156 px, right 296 px); the page content does not overflow horizontally.
- Browser error/warning log check: none.
- Website production build and all four Sites worker tests passed.

## Implementation checklist

- [x] Replace the native select with an accessible button/listbox component.
- [x] Preserve language storage, translated assets and the existing theme toggle.
- [x] Match the supplied light-theme reference and adapt dark mode.
- [x] Verify keyboard, dismissal, persistence and responsive behavior.
- [x] Leave the running local preview open with the menu expanded.

## Follow-up polish

No blocking findings remain. The small trigger-width difference is accepted as an existing-font constraint.

## Legal pages and footer (2026-11-15)

- Added /terms and /privacy with Japanese/English content and shared theme controls; retained the language-menu work above.
- Checked footer navigation to Terms, Terms-to-Privacy navigation, translated content after navigation, and home section links from legal pages.
- Checked English Privacy at 375 px: no horizontal overflow. Checked Japanese Privacy in dark mode at desktop width.
- Page title and canonical URL match the legal page. Browser warnings/errors: none.
- Production build and all four Sites worker tests passed. Deployed to Cloudflare Pages on 2026-11-15 (https://58622bb3.undotree.pages.dev); verified /, /terms, and /privacy on https://undotree.ruhenheim.org/ return 200 and load the current index-qPwVqt-D.js build. Verified provider name mmiyaji and the footer links in the production browser.
- Screenshot: D:/AI/Codex/.codex/visualizations/2026/11/14/01a1db51-f642-7530-85d1-88ce88bcd173/privacy-page.png.

## Screenshot feature demos (2026-11-15)

- Added a sidebar entry and #demos section with actual Diff and pins screenshots, concrete steps, Pair Diff explanation, and full-size image links.
- Japanese and English descriptions, captions, alt text, and screenshot-language notes checked. Screenshot assets remain the real Japanese UI in both languages.
- Verified both images load, the full-size Diff image opens, the browser returns to the page, and the initial #demos link scrolls to the section.
- Checked English/light at 375 px: no horizontal overflow; images fit the content width. Desktop Japanese/dark screenshot inspected. Browser warnings/errors: none.
- Build and all four Sites tests passed. Published to https://2f45700b.undotree.pages.dev and verified index-rYIa4oz7.js with both screenshot assets on the custom domain.
- Screenshot: D:/AI/Codex/.codex/visualizations/2026/11/14/01a1db51-f642-7530-85d1-88ce88bcd173/published-feature-demos.png.

## Realistic screenshot revision (2026-11-15)

- Replaced the repeated-text screenshots with new, unaltered captures of the actual VS Code extension in an isolated demo workspace, at a compact 1442 × 601 window size.
- products.ts changes add in-stock filtering, ascending price sorting, and Japanese-yen formatting. The diff is opened by selecting the earlier checkpoint in Undo Tree’s Diff mode.
- Captured the same code with the improvement checkpoint pinned. Updated Japanese/English captions and alt text to match the new code and actual checkpoint notes.
- Build and all four Sites tests passed. Deployed https://d2cc3915.undotree.pages.dev and verified both new JPEG assets load at their expected dimensions on the production custom domain.
- Production screenshot: D:/AI/Codex/.codex/visualizations/2026/11/14/01a1db51-f642-7530-85d1-88ce88bcd173/realistic-code-demos.png.
