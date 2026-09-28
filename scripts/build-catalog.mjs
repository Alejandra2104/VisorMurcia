import fs from 'node:fs';

const CKAN = 'https://datosabiertos.regiondemurcia.es/api/3/action/package_search?rows=1000&sort=metadata_modified+desc';

function mapPackages(results) {
  const map = new Map();
  for (const pkg of results) {
    let year = 2014;
    if (pkg.metadata_modified) year = new Date(pkg.metadata_modified).getFullYear();
    else if (pkg.metadata_created) year = new Date(pkg.metadata_created).getFullYear();
    const org = pkg.organization?.title || 'Sin Categoría';
    const category = pkg.groups?.[0]?.title || 'General';
    const resources = pkg.resources || [];
    if (!resources.length) continue;
    let recs = resources.map((r) => {
      const fmt = (r.format || '').toUpperCase();
      const url = r.url || '';
      const low = url.toLowerCase();
      let type = 'B';
      if (r.datastore_active === true) type = 'A';
      else if (['WMS','WFS','SHP','KML','KMZ','GEOJSON'].includes(fmt) || low.includes('wms') || low.includes('wfs') || low.endsWith('.zip') || low.endsWith('.kmz')) type = 'C';
      let score = 1;
      if (fmt === 'JSON' || fmt === 'GEOJSON') score = 5;
      else if (fmt.includes('XLS')) score = 4;
      else if (r.datastore_active === true) score = 3;
      else if (fmt === 'CSV') score = 2;
      else if (['KML','SHP','ZIP','KMZ','XML'].includes(fmt)) score = 3;
      return { id: r.id, name: r.name || fmt || 'Recurso', format: fmt || 'WEB', downloadUrl: url, datastoreActive: r.datastore_active === true, type, score };
    });
    recs = recs.filter((it, i, self) => i === self.findIndex((t) => t.downloadUrl === it.downloadUrl));
    recs.sort((a, b) => b.score - a.score);
    const key = `${(pkg.title || '').trim().toLowerCase()}-${org.trim().toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, { id: pkg.id, title: pkg.title, org, category, year: year >= 2014 ? year : 2014, pageUrl: `https://datosabiertos.regiondemurcia.es/dataset/${pkg.name}`, recursosDisponibles: recs, recursoSeleccionadoPorDefecto: recs[0] });
    } else {
      const ex = map.get(key);
      const ids = new Set(ex.recursosDisponibles.map((r) => r.id));
      for (const r of recs) if (!ids.has(r.id)) { ex.recursosDisponibles.push(r); ids.add(r.id); }
      ex.recursosDisponibles.sort((a, b) => b.score - a.score);
      ex.recursoSeleccionadoPorDefecto = ex.recursosDisponibles[0];
    }
  }
  return [...map.values()];
}

const res = await fetch(CKAN, { headers: { 'User-Agent': 'visor-murcia-pages-build' } });
if (!res.ok) throw new Error(`CKAN HTTP ${res.status}`);
const data = await res.json();
if (!data.success) throw new Error('CKAN success=false');
const datasets = mapPackages(data.result.results);
const out = process.argv[2] || 'datasets.json';
fs.writeFileSync(out, JSON.stringify(datasets));
console.log(`OK: ${datasets.length} datasets -> ${out}`);
