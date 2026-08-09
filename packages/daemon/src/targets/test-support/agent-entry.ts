/**
 * Bare entry point for agent.test.ts: the agent has to run as its own process
 * for its teardown to mean anything, and this is the smallest thing that
 * starts one without going through the whole CLI.
 */
import { runTargetAgent } from '../agent.js';

await runTargetAgent();
