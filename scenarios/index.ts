/**
 * Shared planning scenarios used by both the test suite (ground-truth
 * assertions in tests/) and the web preview (examples/web). Keeping the domain
 * definitions in one place means the tests and the demo never drift apart.
 */
export * from "./blocks";
export * from "./staircase";
export * from "./squad-combat";
// The single-agent scenario shares squad-combat's tactical vocabulary (SHOT_DAMAGE,
// isSoftCover, …), so it is namespaced here to avoid flat-barrel collisions. Import
// directly from "./solo-combat" / "./lib/*" for the flat names.
export * as solo from "./solo-combat";
export * as geometry from "./lib/geometry";
export * as field from "./lib/field";
