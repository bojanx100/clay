# Debug Report: New project folder selection

Date: 2026-08-04

## Symptom

The Add project modal asked only for a project name in New project mode. It did not show or allow changing the destination folder, leaving users unable to tell where the project would be created.

## Root cause

The original client sent `create_project` with only a `name`. Both WebSocket handlers forwarded only that name, and `lib/daemon.js` silently selected `~/clay-projects` in single-user mode or `/var/clay/projects` in multi-user mode. Folder selection was absent from the protocol, not merely hidden by the UI.

## Fix

- Existing directory and New project now share one labeled folder-path picker.
- New project defaults to an explicit full target such as `~/clay-projects/new-project`, selects the final folder name for immediate editing, and explains that Clay will create that exact folder.
- Both project and global WebSocket handlers validate the explicit path, preserve legacy name-only clients, and forward the chosen parent folder.
- The daemon creates the exact requested target, rejects missing parents and existing targets, enforces multi-user home containment including symlink resolution, and only removes a directory that this creation attempt actually made.
- The modal ignores stale browse results after a mode or path change.
- Add-project code was extracted from `app-projects.js`; both client modules are now below 500 lines.

## Evidence

- `node --test test/project-creation-path.test.js`: 7/7 passed.
- `node --test test/*.test.js`: 588/588 passed.
- Browser QA verified Existing/New/Clone mode switching, distinct path values, exact New project label and helper copy, final-name selection, stale-suggestion suppression, and no console errors.
- Final browser screenshot: `/tmp/clay-new-project-folder-final.png`.

## Regression test

`test/project-creation-path.test.js` covers explicit path resolution, legacy compatibility, normal folder names, containment boundaries, handler forwarding, non-admin restrictions, and the client folder-picker contract.

## Related

The implementation originated in commit `9c7bf96919` (`feat(project): add empty project creation and GitHub clone modes`). It intentionally introduced a name-only form and daemon-selected default, so this was a missing product capability rather than a later rendering regression.

## Status

DONE
