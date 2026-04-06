const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, updateDoc } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');

const firebaseConfig = {
  apiKey: "AIzaSyBorY6UphXhcsSVQbbjJC8AT-lyWlQ1OHY",
  authDomain: "mexico-trip-c5644.firebaseapp.com",
  projectId: "mexico-trip-c5644",
  storageBucket: "mexico-trip-c5644.firebasestorage.app",
  messagingSenderId: "580916268978",
  appId: "1:580916268978:web:906f524d9c21e730685eab"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const FEEDBACK_FILE = path.join(__dirname, 'feedback.md');

async function main() {
  const mode = process.argv[2]; // 'resolve' or undefined (fetch)

  // Resolve mode: mark feedback items as resolved by ID
  if (mode === 'resolve') {
    const ids = process.argv.slice(3);
    if (!ids.length) { console.log('Usage: node fetch-feedback.js resolve <id1> <id2> ...'); process.exit(1); }
    for (const id of ids) {
      await updateDoc(doc(db, 'feedback', id), { resolved: true });
      console.log('Resolved:', id);
    }
    // Re-fetch after resolving
    await fetchAndWrite();
    return;
  }

  await fetchAndWrite();
}

async function fetchAndWrite() {
  const snap = await getDocs(collection(db, 'feedback'));
  const items = [];
  snap.forEach(d => {
    const data = d.data();
    items.push({
      id: d.id,
      type: data.type || 'bug',
      message: data.message || '',
      user: data.user ? (data.user.name || data.user.email || 'anonymous') : 'anonymous',
      tripId: data.tripId || null,
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString().slice(0, 16).replace('T', ' ') : 'unknown',
      resolved: !!data.resolved
    });
  });

  // Sort: unresolved first, then by date descending
  items.sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  // Write markdown
  let md = '# Feedback\n\n';
  md += `Last synced: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n`;

  const bugs = items.filter(i => i.type === 'bug');
  const features = items.filter(i => i.type === 'feature');

  if (bugs.length) {
    md += '## Bug Reports\n\n';
    bugs.forEach(i => {
      const check = i.resolved ? 'x' : ' ';
      md += `- [${check}] **${i.message.replace(/\n/g, ' ')}**\n`;
      md += `  - ID: \`${i.id}\` | From: ${i.user} | ${i.createdAt}${i.tripId ? ' | Trip: ' + i.tripId : ''}\n`;
    });
    md += '\n';
  }

  if (features.length) {
    md += '## Feature Requests\n\n';
    features.forEach(i => {
      const check = i.resolved ? 'x' : ' ';
      md += `- [${check}] **${i.message.replace(/\n/g, ' ')}**\n`;
      md += `  - ID: \`${i.id}\` | From: ${i.user} | ${i.createdAt}${i.tripId ? ' | Trip: ' + i.tripId : ''}\n`;
    });
    md += '\n';
  }

  if (!items.length) {
    md += '_No feedback yet._\n';
  }

  md += '---\n\nTo resolve: `node fetch-feedback.js resolve <id>`\n';

  fs.writeFileSync(FEEDBACK_FILE, md);
  console.log(`Wrote ${items.length} items to feedback.md (${bugs.length} bugs, ${features.length} features)`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
