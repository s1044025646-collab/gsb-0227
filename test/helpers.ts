import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { ContactService } from '../src/service.js';

export function makeService(): { service: ContactService; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vcard-test-'));
  const db = openDatabase(dir);
  return {
    dir,
    service: new ContactService(db),
    close: () => {
      db.close();
    },
  };
}
