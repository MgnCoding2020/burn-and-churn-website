#!/usr/bin/env node
// The Menu list's starting rows, from seed/menu.json (docs/contracts/sharepoint-lists.md).
// Printed as JSON for scripts/tenant/setup-sharepoint.ps1 -SeedMenu, so the SharePoint
// list starts identical to today's site. One mapping, unit-tested in
// tests/unit/sharepoint-contract.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PRICE_COLUMNS = {
  single: 'PriceDouble',
  '12oz': 'Price12',
  '16oz': 'Price16',
  '20oz': 'Price20',
};

/** seed/menu.json → Menu list rows (prices in dollars, as SharePoint currency columns store them). */
export function menuSeedRows(menu) {
  const order = new Map();
  return menu.items.map((item) => {
    const n = (order.get(item.category) ?? 0) + 1;
    order.set(item.category, n);
    const row = {
      Title: item.name,
      ItemId: item.id,
      Category: item.category,
      Description: item.description,
      Tags: item.iced ? 'iced' : 'hot',
      Active: item.available !== false,
      SortOrder: n * 10,
    };
    for (const [size, cents] of Object.entries(item.prices)) {
      const column = PRICE_COLUMNS[size];
      if (!column) throw new Error(`Unknown size "${size}" on ${item.id}`);
      row[column] = cents / 100;
    }
    return row;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const menu = JSON.parse(readFileSync(new URL('../../seed/menu.json', import.meta.url), 'utf8'));
  process.stdout.write(`${JSON.stringify(menuSeedRows(menu), null, 2)}\n`);
}
