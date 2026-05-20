#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ACCOUNT = 'outlook';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const MESSAGES_DIR = join(DATA_DIR, 'messages');
const DIGESTS_DIR = join(DATA_DIR, 'digests');
const PURCHASES_DIR = join(DATA_DIR, 'purchases');
const STATE_FILE = join(DATA_DIR, 'state.json');

const NOISE_SENDERS = [
  'noreply', 'no-reply', 'notifications@', 'calendar-notification',
  'mailer-daemon', 'postmaster', 'donotreply',
];

const SIGNATURE_PATTERNS = [
  /docusign/i, /dropbox sign/i, /hellosign/i, /pandadoc/i,
  /please sign/i, /signature needed/i, /ready for your signature/i,
  /everyone has signed/i, /you just signed/i,
];

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastCollect: null, knownMessageIds: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function isNoise(addr) {
  const a = (addr || '').toLowerCase();
  return NOISE_SENDERS.some(p => a.includes(p));
}

function isSignature(subject, addr) {
  return SIGNATURE_PATTERNS.some(p => p.test(subject || '') || p.test(addr || ''));
}

function stripMimeMarkers(text) {
  return (text || '').replace(/<#part[^>]*>/g, '').trim();
}

function parseDate(dateStr) {
  return (dateStr || '').split(' ')[0] || new Date().toISOString().split('T')[0];
}

function fetchEnvelopes(folder, sinceDate, page) {
  const folderFlag = folder ? `--folder "${folder}"` : '';
  const raw = run(`himalaya envelope list --account ${ACCOUNT} ${folderFlag} -o json --page ${page} -s 50 "after ${sinceDate}"`);
  return JSON.parse(raw);
}

function fetchBody(id) {
  const raw = run(`himalaya message read --account ${ACCOUNT} -o json ${id}`);
  return stripMimeMarkers(JSON.parse(raw));
}

async function collect(sinceDate) {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  const newRecords = [];

  // null = INBOX, 'Sent' = sent folder (verified against `himalaya folder list`)
  for (const folder of [null, 'Sent']) {
    const isSent = folder !== null;
    const label = folder || 'INBOX';
    console.log(`\nFetching ${label} since ${sinceDate}...`);

    let page = 1;
    while (true) {
      let envelopes;
      try {
        envelopes = fetchEnvelopes(folder, sinceDate, page);
      } catch (e) {
        // himalaya signals end-of-results with a "page N out of bounds" error
        if (e.message.includes('out of bounds')) break;
        console.error(`  [error] ${label} page ${page}: ${e.message.split('\n')[0]}`);
        break;
      }
      if (!envelopes || envelopes.length === 0) break;

      for (const env of envelopes) {
        const uid = String(env.id);
        if (state.knownMessageIds[uid]) { process.stdout.write('.'); continue; }

        const fromAddr = env.from?.addr || '';
        const fromName = env.from?.name || fromAddr;
        const subject = env.subject || '(no subject)';
        const date = parseDate(env.date);

        let body = '';
        try {
          body = fetchBody(uid);
        } catch (e) {
          body = '[body unavailable]';
        }

        const noise = isNoise(fromAddr);
        const sig = !noise && isSignature(subject, fromAddr);
        const tag = isSent ? 'sent' : sig ? 'sig' : noise ? 'noise' : 'inbox';
        console.log(`  [${tag}] ${subject} — ${fromAddr}`);

        const record = {
          imap_id: uid,
          folder: label,
          is_sent: isSent,
          subject,
          from_name: fromName,
          from_addr: fromAddr,
          date,
          body,
          is_noise: noise,
          is_signature: sig,
          retrieval_ref: `himalaya message read --account ${ACCOUNT} ${uid}`,
        };

        state.knownMessageIds[uid] = { date, subject, is_sent: isSent };
        if (!isSent) newRecords.push(record);
      }
      page++;
    }
  }

  const byDate = {};
  for (const r of newRecords) {
    (byDate[r.date] = byDate[r.date] || []).push(r);
  }
  for (const [date, records] of Object.entries(byDate)) {
    const file = join(MESSAGES_DIR, `${date}.json`);
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, JSON.stringify([...existing, ...records], null, 2));
  }

  state.lastCollect = today;
  saveState(state);
  console.log(`\nDone. ${newRecords.length} new messages collected.`);
}

function digest() {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const dates = [today, yesterday.toISOString().split('T')[0]];

  const allRecords = [];
  for (const date of dates) {
    const file = join(MESSAGES_DIR, `${date}.json`);
    if (existsSync(file)) allRecords.push(...JSON.parse(readFileSync(file, 'utf8')));
  }

  if (allRecords.length === 0) {
    console.log('No messages found. Run collect first.');
    return;
  }

  const signatures = allRecords.filter(r => r.is_signature);
  const triage = allRecords.filter(r => !r.is_signature && !r.is_noise);
  const noise = allRecords.filter(r => r.is_noise);

  const lines = [
    `# Email Digest: ${today}`,
    `_${allRecords.length} total — ${triage.length} triage, ${signatures.length} signatures, ${noise.length} noise_`,
    '',
  ];

  if (signatures.length) {
    lines.push('## Signatures Pending');
    for (const r of signatures) {
      lines.push(`- **${r.subject}** — ${r.from_name} <${r.from_addr}>`);
      lines.push(`  \`${r.retrieval_ref}\``);
    }
    lines.push('');
  }

  lines.push('## Messages to Triage');
  if (triage.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const r of triage) {
      lines.push(`### ${r.subject}`);
      lines.push(`**From:** ${r.from_name} <${r.from_addr}>  |  **Date:** ${r.date}`);
      lines.push(`**Read:** \`${r.retrieval_ref}\``);
      lines.push('');
      const snippet = r.body.split('\n').filter(l => l.trim()).slice(0, 6).join('\n');
      lines.push(snippet);
      lines.push('');
    }
  }

  if (noise.length) {
    lines.push(`## Noise (${noise.length} filtered)`);
    for (const r of noise) lines.push(`- ${r.subject} — ${r.from_addr}`);
    lines.push('');
  }

  const digestFile = join(DIGESTS_DIR, `${today}.md`);
  writeFileSync(digestFile, lines.join('\n'));
  console.log(`Digest → ${digestFile}`);
  console.log(`  ${triage.length} triage  ${signatures.length} signatures  ${noise.length} noise`);
}

// Amazon order confirmation senders
const AMAZON_ORDER_SENDERS = ['auto-confirm@amazon.com', 'auto-confirm@amazon.com.au'];

function parseAmazonOrders(body, emailDate) {
  const orders = [];
  const lines = body.split('\n').map(l => l.trim());

  let i = 0;
  while (i < lines.length) {
    // Find "Order #" marker
    if (lines[i] === 'Order #' && lines[i + 1]) {
      const orderNumber = lines[i + 1].trim();
      i += 2;

      const items = [];
      let total = null;

      while (i < lines.length) {
        const line = lines[i];

        // Next order block starts
        if (line === 'Order #') break;

        // Item line starts with "* "
        if (line.startsWith('* ')) {
          const descLines = [line.slice(2).trim()];
          i++;
          // Accumulate continuation lines until Quantity:
          while (i < lines.length && !lines[i].startsWith('Quantity:') && !lines[i].startsWith('* ') && lines[i] !== 'Total' && lines[i] !== 'Order #') {
            if (lines[i]) descLines.push(lines[i]);
            i++;
          }
          const description = descLines.join(' ');

          let quantity = 1;
          let price = null;

          if (lines[i]?.startsWith('Quantity:')) {
            quantity = parseInt(lines[i].replace('Quantity:', '').trim(), 10) || 1;
            i++;
          }
          // Price line: "{amount} AUD"
          if (lines[i] && /^\d+\.\d{2}\s+AUD$/i.test(lines[i])) {
            price = parseFloat(lines[i]);
            i++;
          }

          items.push({ description, quantity, price_aud: price });
          continue;
        }

        // Total line
        if (line === 'Total' && lines[i + 1] && /^\d+\.\d{2}\s+AUD$/i.test(lines[i + 1])) {
          total = parseFloat(lines[i + 1]);
          i += 2;
          continue;
        }

        i++;
      }

      if (orderNumber && items.length > 0) {
        orders.push({ order_number: orderNumber, date: emailDate, total_aud: total, items });
      }
      continue;
    }
    i++;
  }

  return orders;
}

function purchases() {
  mkdirSync(PURCHASES_DIR, { recursive: true });

  const allMessages = [];
  if (existsSync(MESSAGES_DIR)) {
    for (const f of readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'))) {
      allMessages.push(...JSON.parse(readFileSync(join(MESSAGES_DIR, f), 'utf8')));
    }
  }

  const orderEmails = allMessages.filter(m =>
    AMAZON_ORDER_SENDERS.some(s => m.from_addr.includes(s.split('@')[1]))
    && m.from_addr.includes('auto-confirm')
  );

  let written = 0;
  let skipped = 0;

  for (const msg of orderEmails) {
    const orders = parseAmazonOrders(msg.body, msg.date);
    for (const order of orders) {
      const file = join(PURCHASES_DIR, `${order.order_number}.json`);
      if (existsSync(file)) { skipped++; continue; }
      const record = {
        ...order,
        source_imap_id: msg.imap_id,
        source_subject: msg.subject,
        retrieval_ref: msg.retrieval_ref,
        extracted_at: new Date().toISOString().split('T')[0],
      };
      writeFileSync(file, JSON.stringify(record, null, 2));
      console.log(`  [order] ${order.order_number} — ${order.items.length} items — $${order.total_aud} AUD`);
      for (const item of order.items) {
        console.log(`    • ${item.description.slice(0, 70)} — $${item.price_aud}`);
      }
      written++;
    }
  }

  console.log(`\nDone. ${written} orders written, ${skipped} already exist.`);
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (cmd === 'collect') {
  const si = args.indexOf('--since');
  let since;
  if (si !== -1) {
    since = args[si + 1];
  } else {
    const d = new Date(); d.setDate(d.getDate() - 1);
    since = d.toISOString().split('T')[0];
  }
  collect(since).catch(e => { console.error(e.message); process.exit(1); });
} else if (cmd === 'digest') {
  digest();
} else if (cmd === 'purchases') {
  purchases();
} else {
  console.log('Usage:');
  console.log('  node email-collector.mjs collect [--since YYYY-MM-DD]');
  console.log('  node email-collector.mjs digest');
  console.log('  node email-collector.mjs purchases');
  process.exit(1);
}
