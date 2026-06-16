/**
 * Shared planning scenarios used by both the test suite (ground-truth
 * assertions in tests/) and the web preview (examples/web). Keeping the domain
 * definitions in one place means the tests and the demo never drift apart.
 */
export * from "./blocks";
export * from "./staircase";
export * from "./squad-combat";
// `dive` is imported via its subpath (../scenarios/dive) to avoid barrel name
// collisions with squad-combat's shared constants (MOVE_SPEED, SIGHT_RANGE, …).
