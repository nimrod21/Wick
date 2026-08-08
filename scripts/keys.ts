/**
 * Vault key helper (task 3.6): `pnpm keys set llm.<provider>.key <value>`
 * encrypts an API key into the settings vault (`apikey.<provider>` row, the
 * exact format `config.getApiKey()` reads). `pnpm keys list` shows masked
 * keys. Requires WICK_MASTER_KEY in .env (boot the server once to generate).
 */
import { config } from '../apps/server/src/config.js';
import { db } from '../apps/server/src/db/client.js';
import { encrypt, decrypt, maskKey } from '../apps/server/src/util/crypto-vault.js';

function usage(): never {
  console.error('Usage:');
  console.error('  pnpm keys set llm.<provider>.key <value>   e.g. pnpm keys set llm.groq.key gsk_...');
  console.error('  pnpm keys list');
  process.exit(1);
}

/** `llm.groq.key` → `groq`; also accepts `apikey.groq` or bare `groq`. */
function toProvider(name: string): string {
  const llmMatch = /^llm\.([a-z0-9_-]+)\.key$/i.exec(name);
  if (llmMatch) return llmMatch[1]!.toLowerCase();
  const apikeyMatch = /^apikey\.([a-z0-9_-]+)$/i.exec(name);
  if (apikeyMatch) return apikeyMatch[1]!.toLowerCase();
  if (/^[a-z0-9_-]+$/i.test(name)) return name.toLowerCase();
  usage();
}

function requireMasterKey(): void {
  if (!config.masterKey) {
    console.error(
      'WICK_MASTER_KEY is not set. Boot the server once (`pnpm dev:server`) — it generates the key into .env — then retry.',
    );
    process.exit(1);
  }
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'set') {
    const [name, value] = rest;
    if (!name || !value) usage();
    requireMasterKey();
    const provider = toProvider(name);
    const sealed = encrypt(value);
    const blob = JSON.stringify({
      ct: sealed.ciphertext.toString('base64'),
      iv: sealed.iv.toString('base64'),
      tag: sealed.tag.toString('base64'),
    });
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(`apikey.${provider}`, blob);
    console.log(`Stored key for "${provider}" (settings row apikey.${provider}, AES-GCM).`);
    return;
  }

  if (cmd === 'list') {
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'apikey.%' ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    if (rows.length === 0) {
      console.log('No API keys stored yet. See apps/server/src/llm/README-setup.md');
      return;
    }
    for (const row of rows) {
      const provider = row.key.slice('apikey.'.length);
      let masked = '<cannot decrypt — wrong WICK_MASTER_KEY?>';
      try {
        if (config.masterKey) {
          const blob = JSON.parse(row.value) as { ct: string; iv: string; tag: string };
          masked = maskKey(
            decrypt({
              ciphertext: Buffer.from(blob.ct, 'base64'),
              iv: Buffer.from(blob.iv, 'base64'),
              tag: Buffer.from(blob.tag, 'base64'),
            }),
          );
        }
      } catch {
        /* keep placeholder */
      }
      console.log(`${provider.padEnd(12)} ${masked}`);
    }
    return;
  }

  usage();
}

main();
