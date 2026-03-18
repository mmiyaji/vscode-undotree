# Changelog

## 0.2.1

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
- Added configurable timestamp formats, including `date-fns`-compatible custom formatting with `undotree.timeFormat` and `undotree.timeFormatCustom`.
- Added configurable node marker styles with `undotree.nodeMarkerStyle`, including `none`, `simple`, and `semantic` with `semantic` as the default.
- Improved `none` marker rendering so rows do not keep an empty marker gap.
- Localized command and setting labels through package NLS files, including Japanese translations for the newly added settings.
- Updated tests and README documentation to match the current behavior.
