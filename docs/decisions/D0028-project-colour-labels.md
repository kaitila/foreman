# D0028. Project colour labels live in the project registry (2026-11-09)

**Status:** Active

**Context:** A person running several repos on one board wants to tell them apart at a glance, so each project gets a colour label. The label has to live somewhere and be set from somewhere.

**Chosen:**
- **Nine colours or none:** gray, red, orange, yellow, green, teal, blue, purple, pink. One per project.
- **Kept in the per-user registry** (D0024's `projects.json`): a `colors` map from repo directory to colour, beside the `projects` list. Entries in the list are still only directories. A colour is kept only while its directory is on the list, so `fm projects rm` and `prune` drop it. Setting a colour on a directory that isn't listed adds it; clearing one never does. A file without `colors` reads as before.
- **Set from the board** with `POST /api/p/<project>/color/<colour|none>`, behind the same gate as approve and merge (the token header, the board's own Origin and Host). It applies at once, with no undo window, because it changes nothing about the work. A read-only board can't set it. **From the terminal:** `fm projects color <name|dir> <colour|none>`. An open board picks up a colour set elsewhere within about 10 seconds.
- **Shown as a dot only**, never a fill or a text colour, wherever the project's name appears.

**Why:**
- The registry is already the person's own list of projects, read by the board and the CLI, so one label shows in every browser and in `fm projects`. `localStorage` would keep it per browser, invisible to the CLI.
- `foreman.json` is the repo's shared config and a protected path; a label is personal, and changing it shouldn't need a sign-off.
- The undo window guards writes that are hard to take back. A colour is undone by picking another.

**Revisit if:** labels need to be shared with a team, or a project needs more than a colour (a short name, an icon, a group), or colours get lost: the registry has no lock, so a colour set while another `fm` rewrites `projects.json` (as it does when it opens a repo) can be lost in a rare race. A lock or a merge on write would fix it.
