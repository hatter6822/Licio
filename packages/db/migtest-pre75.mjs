import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const sql = postgres('postgres://licio:licio_dev@localhost:5432/licio_migtest2', {
  max: 1,
  onnotice: () => {},
});
const dir = '/home/3ud/Documents/Web/Licio/packages/db/drizzle';
const journal = JSON.parse(await readFile(`${dir}/meta/_journal.json`, 'utf8'));
const upgrade = new Set([
  '0075_remove_evidence_cards',
  '0076_retire_legacy_write_taxonomy',
  '0077_evidence_decisions',
]);
const phase = process.argv[2];
for (const entry of journal.entries.sort((a, b) => a.idx - b.idx)) {
  const isUpgrade = upgrade.has(entry.tag);
  if ((phase === 'pre' && isUpgrade) || (phase === 'post' && !isUpgrade)) continue;
  const text = await readFile(`${dir}/${entry.tag}.sql`, 'utf8');
  try {
    await sql.begin(async (tx) => {
      for (const stmt of text
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.unsafe(stmt);
    });
  } catch (error) {
    console.error('FAILED AT', entry.tag, String(error?.message ?? error));
    process.exit(1);
  }
}
console.log(phase, 'phase ok');
await sql.end();
