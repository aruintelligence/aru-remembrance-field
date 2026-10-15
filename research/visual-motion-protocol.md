# Visual motion and work scheduling

The 72 × 72 Canvas is decorative; score and evidence calculations do not depend on its frame loop. Previously, CSS shortened animations for a reduced-motion preference, but the Canvas continued stepping and drawing. The current renderer separates painting from stepping and pauses continuous work when motion is reduced, the user turns off **Visual motion**, or the tab is hidden.

| State | Scheduled animation frames | Canvas result | Input behavior |
| --- | --- | --- | --- |
| Visible, motion on | One pending frame at a time; at most 30 step-and-paint passes per second | Animated field | Score and responses update. |
| Reduced-motion preference, no manual choice | None | Static field repaints on input and resize | Score and responses update. |
| Manually paused | None | Static field repaints on input and resize | Score and responses update. |
| Hidden tab | None | No painting while hidden | Score and evidence state remain available on return; scheduled reflections skip hidden periods. |

The switch's `aria-checked` state describes whether motion is on, alongside a visible on/off label. An explicit switch choice controls motion for the current page session even if the device preference changes. Without a choice, a device preference change immediately updates the renderer. On becoming visible, a moving field resumes without replaying missed frames. The Canvas backing resolution is capped at device pixel ratio 2. The viewport allows browser zoom.

Run `node tests/field.test.cjs` from the repository root. The motion tests simulate reduced-motion changes, manual pause and resume, hidden and visible tabs, 0/16/34 ms frames, scoring while paused, and a high pixel ratio. They check scheduled work and modeled state; they are not battery or accessibility certification. In the [live demo](https://aruintelligence.github.io/aru-remembrance-field/), turn visual motion off and submit a phrase to see the static field update without running the continuous animation.
