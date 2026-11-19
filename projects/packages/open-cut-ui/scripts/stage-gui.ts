#!/usr/bin/env node
/**
 * Stages the static VMZ build into `@wae/open-cut/dist/gui`.
 *
 * The native host maps one directory to `https://app.local/`, so the shipped
 * package must contain the UI next to `dist/cli.js`. This script copies and
 * validates `index.html`; it contains no business logic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', 'dist', 'static');
const dest = path.resolve(here, '..', '..', 'open-cut', 'dist', 'gui');

const index = path.join(source, 'index.html');
if (!fs.existsSync(index)) {
    console.error(`open-cut-ui: ${index} is missing. Run \`vmz build . --profile static\` first.`);
    process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(source, dest, { recursive: true });
console.log(`open-cut-ui: staged ${source} -> ${dest}`);
