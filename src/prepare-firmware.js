import fs from 'node:fs/promises';
import path from 'node:path';
import { createFirmwareStore } from './firmware.js';
import { createOriginLookup } from './origin.js';
const directory = process.env.FIRMWARE_DIR || path.join(process.env.DATA_DIR || 'data', 'firmware');
const store = createFirmwareStore({ directory, lookup: createOriginLookup().lookup,
  ...(process.argv[2] ? { download: () => fs.readFile(process.argv[2]) } : {}) });
try {
  await store.load(); await store.prepare();
  console.log(`Verified DIV01 original + patch ready: ${directory}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
