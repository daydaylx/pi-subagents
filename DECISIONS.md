# Architecture decisions

## Fleet status is a read-only projection

The permanent Fleet Status Dock renders the normalized foreground, async, and
nested-run projection. It has no selection, focus, terminal-input routing, or
inline control state. This keeps ordinary editor input independent from status
rendering while retaining compact hierarchy, state glyphs, activity, runtime,
and token information.

## Actions remain explicit

`/subagents-fleet` and `subagent({ action: "status", view: "fleet" })` provide
on-demand status; `view: "transcript"` provides detailed output; and
`/subagents-stop` or `subagent({ action: "stop", id })` stops an async run.
The former permanent inspector and transcript reader duplicated these paths and
were removed.

## One persistent widget

With `ui.fleetView: true`, Fleet is the sole persistent status widget. With it
disabled, the existing async widget remains the compatibility fallback. The
async tracker requests a normal UI repaint for Fleet state changes but never
recreates the legacy widget in Fleet mode.
