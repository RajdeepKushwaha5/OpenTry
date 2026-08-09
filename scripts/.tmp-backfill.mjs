/** Watch the umami backfill to a terminal outcome under the new 20-min timeout. */
const BASE = 'https://api-2d72-3000.prg1.zerops.app';
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;

for (;;) {
  const pool = await fetch(`${BASE}/api/pool`).then((r) => r.json()).catch(() => null);
  const building = await fetch(`${BASE}/api/pool/building`).then((r) => r.json()).catch(() => null);
  const m = await fetch(`${BASE}/api/metrics`).then((r) => r.json()).catch(() => null);

  const u = pool?.apps?.umami;
  console.log(
    `[${el()}] umami ready=${u?.ready} provisioning=${u?.provisioning}` +
      ` | building=${building?.building?.app ?? '-'} ${building?.building ? Math.round(building.building.elapsedMs / 1000) + 's' : ''}` +
      ` | health=${m?.health} rate=${m?.failureRate} ok=${m?.totals?.succeeded} fail=${m?.totals?.failed}`,
  );

  if (u && u.ready >= 1 && !building?.building) {
    console.log(`\nBACKFILL COMPLETED in ~${el()} — provisioning succeeded under the 20-minute timeout.`);
    const deep = await fetch(`${BASE}/api/health/deep`);
    console.log(`/api/health/deep -> HTTP ${deep.status} ${await deep.text()}`);
    break;
  }
  if (Date.now() - t0 > 25 * 60 * 1000) {
    console.log('\nGAVE UP WATCHING after 25 minutes.');
    break;
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
