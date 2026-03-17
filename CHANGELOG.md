# Changelog

## 0.2.0

- Fixed tree initialization when opening an existing file so the initial node reflects the current document content.
- Reworked tree layout rendering to produce stable branch structure and avoid incorrect indentation for linear chains.
- Removed content-based node convergence so editing from an older node always creates a new branch in the history tree.
- Fixed branching behavior when jumping to older nodes and then saving, including autosave timing issues.
- Replaced text-based branch drawing with inline SVG connectors for more consistent alignment and visibility.
- Changed the settings button to open a menu with settings, persisted save, restore, compact, pause/resume, and tracking actions.
- Added persisted history save and restore commands.
- Added on-demand persisted history restore when tracked files are opened again.
- Added `undotree.persistenceMode` with `manual` and `auto` modes.
- Persisted pause state and ensured manual and automatic persistence both retain it.
- Updated tests and README documentation to match the current behavior.
