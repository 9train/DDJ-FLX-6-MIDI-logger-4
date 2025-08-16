// src/testDecode.js
// Adjust the path if board.js is in a different folder
import { decodeRelative7 } from './board.js';

// Color helpers
const green = text => `\x1b[32m${text}\x1b[0m`;
const red   = text => `\x1b[31m${text}\x1b[0m`;
const cyan  = text => `\x1b[36m${text}\x1b[0m`;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(red(`❌ ${label}: expected ${expected}, got ${actual}`));
    process.exitCode = 1;
  } else {
    console.log(green(`✅ ${label}: ${actual}`));
  }
}

console.log(cyan("Running decodeRelative7 tests...\n"));

// Original outputs with added pass/fail
assertEqual(decodeRelative7(1), 1, "decodeRelative7(1)");
assertEqual(decodeRelative7(63), 63, "decodeRelative7(63)");
assertEqual(decodeRelative7(64), 0, "decodeRelative7(64)");
assertEqual(decodeRelative7(65), -63, "decodeRelative7(65)");
assertEqual(decodeRelative7(127), -1, "decodeRelative7(127)");

if (process.exitCode === undefined) {
  console.log(green("\n🎉 All tests passed!"));
}
