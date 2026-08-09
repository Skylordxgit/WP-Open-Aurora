import type { SavedContactRecord } from '../services/api';

function normalizeNumber(value: string) {
  return value.replace(/[^0-9+]/g, '').trim();
}

export function parseContactsCsv(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const hasHeader = /name|number|phone/i.test(lines[0]);
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map(line => {
      const [name = '', number = ''] = line.split(',').map(part => part.trim());
      return {
        name: name || undefined,
        number: normalizeNumber(number || name),
      };
    })
    .filter(item => item.number);
}

export function contactsToCsv(contacts: SavedContactRecord[]) {
  const header = 'name,number,sessionId,source';
  const rows = contacts.map(contact =>
    [contact.name ?? '', contact.number, contact.sessionId ?? '', contact.source]
      .map(value => `"${String(value).replace(/"/g, '""')}"`)
      .join(','),
  );
  return [header, ...rows].join('\n');
}
