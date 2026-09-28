const express = require('express');
// Nota: XLSX/AdmZip/shapefile se cargan DENTRO del handler (lazy) para que
// el arranque en serverless (Vercel 10s) sea rápido. XMLParser/cheerio sobraban.
const proj4 = require('proj4');

const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// CORS abierto para que GitHub Pages pueda usar este backend (igual que en local)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static(require('path').join(__dirname, 'public')));
app.use(express.json());

// Salud para Render/uptime
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback: si el estático no resolvió (ej. serverless), sirve la app
app.get('/', (req, res) => res.sendFile(require('path').join(__dirname, 'index.html')));

// Definir proyecciones cartográficas para transformar coordenadas UTM a WGS84 (Lat/Lon)
proj4.defs("EPSG:25830", "+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs");
proj4.defs("EPSG:23030", "+proj=utm +zone=30 +ellps=intl +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

// Función recursiva para re-proyectar geometrías de metros a grados decimales
function transformCoordinates(coords, sourceProj) {
    if (typeof coords[0] === 'number') {
        if (Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) {
            const transformed = proj4(sourceProj, 'EPSG:4326', [coords[0], coords[1]]);
            return [transformed[0], transformed[1]];
        }
        return coords;
    }
    return coords.map(subCoords => transformCoordinates(subCoords, sourceProj));
}

// Recorta decimales (6 = precisión de ~10 cm) para que el mapa pese
// la mitad y el móvil no se ahogue. Vale para cualquier geometría.
function roundCoords(coords) {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
        return coords.map(n => typeof n === 'number' ? Math.round(n * 1e6) / 1e6 : n);
    }
    return coords.map(roundCoords);
}

// Decodifica UTF-8 y, si sale roto (muchos CSV vienen en latin1),
// lo intenta en latin1 antes de rendirse.
function decodeText(buf) {
    const u8 = buf.toString('utf8').replace(/^\uFEFF/, '');
    if (!u8.includes('\uFFFD')) return u8;
    return buf.toString('latin1').replace(/^\uFEFF/, '');
}

// Decodifica un buffer de texto detectando UTF-16 (algunos CSV vienen así)
function decodeEntryText(buf) {
    const n = Math.min(buf.length, 1000);
    for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return buf.toString('utf16le').replace(/^\uFEFF/, '');
    }
    return buf.toString('utf8').replace(/^\uFEFF/, '');
}

// Parte una línea CSV respetando comillas ("a, b" no se parte)
function splitCsvLine(line, sep) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
            else inQ = !inQ;
        } else if (c === sep && !inQ) { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

// Helpers para reutilizar el parseo de tablas (también dentro de ZIPs)
function parseCsvText(text) {
    const lines = (text || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) return null;
    const first = lines[0];
    if (!first.includes(';') && !first.includes(',')) return null;
    const separator = first.includes(';') ? ';' : ',';
    const headers = splitCsvLine(first, separator).map(h => h.replace(/^["']|["']$/g, '').trim()).filter(h => h !== '');
    if (headers.length < 1) return null;
    // Si la primera línea parece binaria, no es CSV
    if (/[\uFFFD\u0000]/.test(first) || first.length > 20000) return null;
    let rows = [];
    for (let i = 1; i < Math.min(lines.length, 301); i++) {
        const cur = splitCsvLine(lines[i], separator);
        let o = {};
        headers.forEach((h, ix) => { o[h] = cur[ix] !== undefined ? cur[ix].replace(/^["']|["']$/g, '').trim() : ''; });
        rows.push(o);
    }
    if (!rows.length) return null;
    return { headers, rows };
}

function parseExcelBuffer(buf) {
    try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(buf, { type: 'buffer' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
        if (!jsonData.length) return null;
        const headers = Object.keys(jsonData[0]);
        const rows = jsonData.map(item => {
            let o = {};
            headers.forEach(h => { o[h] = item[h] !== undefined ? String(item[h]) : ''; });
            return o;
        });
        return { headers, rows };
    } catch (e) {
        return null;
    }
}

// ---- WMS/WFS incrustados: el navegador no puede leer estos servicios por
// CORS, así que el backend resuelve las capas y devuelve algo pintable ----
function firstArray(x) {
    return Array.isArray(x) ? x : (x ? [x] : []);
}

async function fetchTextTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 15000);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (VisorMurcia)' }, redirect: 'follow' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
    } finally { clearTimeout(t); }
}

function capsParser() {
    const { XMLParser } = require('fast-xml-parser');
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
}

// Lee GetCapabilities WMS y devuelve { url, layers, title, bbox, version }
async function fetchWmsConfig(downloadUrl) {
    const base = downloadUrl.split('?')[0];
    const xml = await fetchTextTimeout(base + '?SERVICE=WMS&REQUEST=GetCapabilities', 15000);
    const caps = capsParser().parse(xml);
    const rootKey = Object.keys(caps).find(k => /capabilit/i.test(k)) || Object.keys(caps).find(k => k !== '?xml') || Object.keys(caps)[0];
    const root = caps[rootKey];
    if (!root) return null;
    const version = root['@_version'] || '1.1.1';
    const cap = root.Capability || {};
    const topLayer = cap.Layer || {};
    let wanted = null;
    try {
        const p = new URL(downloadUrl).searchParams;
        wanted = p.get('layer') || p.get('layers') || p.get('typename') || p.get('TYPENAME');
    } catch (e) {}
    const layers = [];
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.Name) {
            const name = String(node.Name);
            const title = node.Title ? String(node.Title) : name;
            let bbox = null;
            const ex = node.EX_GeographicBoundingBox;
            if (ex && ex.westBoundLongitude !== undefined) {
                bbox = [parseFloat(ex.westBoundLongitude), parseFloat(ex.southBoundLatitude),
                        parseFloat(ex.eastBoundLongitude), parseFloat(ex.northBoundLatitude)];
            } else if (node.LatLonBoundingBox && node.LatLonBoundingBox['@_minx'] !== undefined) {
                const b = node.LatLonBoundingBox;
                bbox = [parseFloat(b['@_minx']), parseFloat(b['@_miny']), parseFloat(b['@_maxx']), parseFloat(b['@_maxy'])];
            }
            layers.push({ name, title, bbox });
        }
        firstArray(node.Layer).forEach(walk);
    };
    walk(topLayer);
    if (!layers.length) return null;
    if (wanted) {
        const i = layers.findIndex(l => l.name.toLowerCase() === String(wanted).toLowerCase());
        if (i > 0) { const w = layers.splice(i, 1)[0]; layers.unshift(w); }
    }
    return { url: base, layers: layers.slice(0, 5).map(l => l.name), title: layers[0].title, bbox: layers[0].bbox, version };
}

// Lee WFS: capabilities -> primera capa -> GetFeature GeoJSON (500 elementos)
async function fetchWfsGeoJson(downloadUrl) {
    const base = downloadUrl.split('?')[0];
    let wanted = null;
    try {
        const p = new URL(downloadUrl).searchParams;
        wanted = p.get('typename') || p.get('TYPENAME') || p.get('typenames') || p.get('layer') || p.get('layers');
    } catch (e) {}
    const xml = await fetchTextTimeout(base + '?SERVICE=WFS&REQUEST=GetCapabilities', 15000);
    const caps = capsParser().parse(xml);
    const rootKey = Object.keys(caps).find(k => /capabilit/i.test(k)) || Object.keys(caps).find(k => k !== '?xml') || Object.keys(caps)[0];
    const root = caps[rootKey];
    if (!root) return null;
    const list = root.FeatureTypeList || {};
    const types = firstArray(list.FeatureType).map(t => ({
        name: String((t.Name !== undefined ? t.Name : '') || ''),
        title: String((t.Title !== undefined ? t.Title : t.Name) || '')
    })).filter(t => t.name);
    if (!types.length) return null;
    let chosen = types[0];
    if (wanted) {
        const f = types.find(t => t.name.toLowerCase() === String(wanted).toLowerCase());
        if (f) chosen = f;
    }
    const queries = [
        base + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAME=' + encodeURIComponent(chosen.name) + '&OUTPUTFORMAT=application/json&COUNT=500',
        base + '?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=' + encodeURIComponent(chosen.name) + '&OUTPUTFORMAT=application/json&MAXFEATURES=500'
    ];
    for (const q of queries) {
        try {
            const gj = JSON.parse(await fetchTextTimeout(q, 20000));
            if (gj && gj.type === 'FeatureCollection' && Array.isArray(gj.features) && gj.features.length) {
                gj.features.forEach(f => {
                    if (f.geometry && f.geometry.coordinates) {
                        f.geometry.coordinates = roundCoords(f.geometry.coordinates);
                    }
                });
                return gj;
            }
        } catch (e) {}
    }
    return null;
}

app.get('/api/datasets', async (req, res) => {
    try {
        const response = await fetch('https://datosabiertos.regiondemurcia.es/api/3/action/package_search?rows=1000&sort=metadata_modified+desc');
        const data = await response.json();

        if (!data.success) return res.status(500).json({ error: "Error en la API" });

        let datasetsMap = new Map();

        data.result.results.forEach(pkg => {
            let year = 2014;
            if (pkg.metadata_modified) {
                year = new Date(pkg.metadata_modified).getFullYear();
            } else if (pkg.metadata_created) {
                year = new Date(pkg.metadata_created).getFullYear();
            } else if (pkg.revision_timestamp) {
                year = new Date(pkg.revision_timestamp).getFullYear();
            }

            const org = pkg.organization?.title || 'Sin Categoría';
            const category = pkg.groups && pkg.groups.length > 0 ? pkg.groups[0].title : 'General';
            const resources = pkg.resources || [];

            if (resources.length === 0) return;

            let recursosDelPaquete = resources.map(r => {
                const fmt = (r.format || '').toUpperCase();
                const url = r.url || '';
                const urlLower = url.toLowerCase();

                let type = 'B'; 
                if (r.datastore_active === true) {
                    type = 'A'; 
                } else if (['WMS', 'WFS', 'SHP', 'KML', 'KMZ', 'GEOJSON'].includes(fmt) || urlLower.includes('wms') || urlLower.includes('wfs') || urlLower.endsWith('.zip') || urlLower.endsWith('.kmz')) {
                    type = 'C'; 
                }

                let score = 1;
                if (fmt === 'JSON' || fmt === 'GEOJSON') score = 5;
                else if (fmt.includes('XLS')) score = 4;
                else if (r.datastore_active === true) score = 3;
                else if (fmt === 'CSV') score = 2;
                else if (['KML', 'SHP', 'ZIP', 'KMZ', 'XML'].includes(fmt)) score = 3;
                else if (fmt.includes('HTML')) score = 1;

                return {
                    id: r.id,
                    name: r.name || fmt || 'Recurso',
                    format: fmt || 'WEB',
                    downloadUrl: url,
                    datastoreActive: r.datastore_active === true,
                    type: type,
                    score: score
                };
            });

            recursosDelPaquete = recursosDelPaquete.filter((item, index, self) =>
                index === self.findIndex((t) => t.downloadUrl === item.downloadUrl)
            );

            recursosDelPaquete.sort((a, b) => b.score - a.score);

            const cleanTitle = (pkg.title || '').trim().toLowerCase();
            const cleanOrg = org.trim().toLowerCase();
            const uniqueKey = `${cleanTitle}-${cleanOrg}`;

            if (!datasetsMap.has(uniqueKey)) {
                datasetsMap.set(uniqueKey, {
                    id: pkg.id,
                    title: pkg.title,
                    org: org,
                    category: category,
                    year: year >= 2014 ? year : 2014,
                    pageUrl: `https://datosabiertos.regiondemurcia.es/dataset/${pkg.name}`,
                    recursosDisponibles: recursosDelPaquete,
                    recursoSeleccionadoPorDefecto: recursosDelPaquete[0]
                });
            } else {
                const existing = datasetsMap.get(uniqueKey);
                const existingResourceIds = new Set(existing.recursosDisponibles.map(r => r.id));
                
                recursosDelPaquete.forEach(r => {
                    if (!existingResourceIds.has(r.id)) {
                        existing.recursosDisponibles.push(r);
                        existingResourceIds.add(r.id);
                    }
                });
                
                existing.recursosDisponibles.sort((a, b) => b.score - a.score);
                existing.recursoSeleccionadoPorDefecto = existing.recursosDisponibles[0];
            }
        });

        res.json(Array.from(datasetsMap.values()));
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Error interno al conectar con la API" });
    }
});

app.post('/api/fetch-dataset-content', async (req, res) => {
    const { resourceId, downloadUrl, format, datastoreActive, type } = req.body;

    try {
        const fmt = (format || '').toUpperCase();
        const urlLower = (downloadUrl || '').toLowerCase();

        if (!downloadUrl) return res.status(400).json({ error: "El recurso no dispone de URL de descarga." });

        // Los servicios WMS/WFS se intentan incrustar como mapa de verdad
        // (los enlaces guardados en el catálogo suelen estar rotos o ser
        // solo una leyenda). Si no se puede, se devuelve el enlace como antes.
        const isFileUrl = /\.(zip|kmz|kml|xml|csv|xls|xlsx|json|geojson)(\?|$)/.test(urlLower);
        const wantsWfs = fmt === 'WFS' || (!isFileUrl && urlLower.includes('wfs'));
        const isWmsService = fmt === 'WMS' || fmt === 'WFS' || (!isFileUrl && (urlLower.includes('wms') || urlLower.includes('wfs')));
        if (isWmsService) {
            try {
                if (wantsWfs) {
                    const gj = await fetchWfsGeoJson(downloadUrl);
                    if (gj) return res.json({ isGeoJson: true, geojson: gj });
                } else {
                    const wms = await fetchWmsConfig(downloadUrl);
                    if (wms) return res.json({ isMap: true, format: 'WMS', wms: wms, mapUrl: downloadUrl });
                }
            } catch (e) {
                console.warn('WMS/WFS incrustado falló, doy enlace:', e.message);
            }
            return res.json({ isMap: true, format: fmt || 'WMS', mapUrl: downloadUrl });
        }

        // Descarga del archivo. Si falla, no nos rendimos: abajo se intenta
        // el datastore de CKAN, que no necesita el archivo.
        let buffer = null;
        let textData = '';
        let cleanText = '';
        try {
            const fileRes = await fetch(downloadUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
            if (!fileRes.ok) throw new Error('HTTP ' + fileRes.status);
            const arrayBuffer = await fileRes.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);
            textData = decodeText(buffer);
            cleanText = textData.trim();
        } catch (dlErr) {
            console.warn('Descarga directa falló, pruebo datastore:', downloadUrl, dlErr.message);
        }

        // 1. KML / XML directo
        if (buffer && (fmt === 'KML' || fmt === 'XML' || urlLower.endsWith('.kml') || urlLower.endsWith('.xml') || cleanText.includes('<kml') || cleanText.includes('<document>') || cleanText.startsWith('<?xml'))) {
            return res.json({ isMap: true, format: 'KML', rawContent: textData });
        }

        // 2. KMZ (Extraer el XML/KML de dentro del ZIP al igual que un KML)
        if (buffer && (urlLower.endsWith('.kmz') || fmt === 'KMZ')) {
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(buffer);
                for (let entry of zip.getEntries()) {
                    const name = entry.entryName.toLowerCase();
                    if (name.endsWith('.kml') || name.endsWith('.xml')) {
                        const xmlText = entry.getData().toString('utf8');
                        return res.json({ isMap: true, format: 'KML', rawContent: xmlText });
                    }
                }
            } catch (e) {
                console.error("Error leyendo KMZ:", e);
            }
        }

        // 3. SHAPEFILES EN ZIP (Con lectura robusta y conversión automática de coordenadas UTM a Grados)
        if (buffer && (urlLower.endsWith('.zip') || fmt === 'SHP' || fmt === 'ZIP')) {
            try {
                const AdmZip = require('adm-zip');
                const shapefile = require('shapefile');
                const zip = new AdmZip(buffer);
                let shpBuffer = null;
                let dbfBuffer = null;
                let shxBuffer = null;
                let prjText = null;

                for (let entry of zip.getEntries()) {
                    const name = entry.entryName.toLowerCase();
                    if (name.includes('__macosx') || name.startsWith('.')) continue;

                    if (name.endsWith('.shp')) shpBuffer = entry.getData();
                    if (name.endsWith('.dbf')) dbfBuffer = entry.getData();
                    if (name.endsWith('.shx')) shxBuffer = entry.getData();
                    if (name.endsWith('.prj') || name.endsWith('.qpj')) {
                        prjText = entry.getData().toString('utf8');
                    }
                }

                if (shpBuffer && dbfBuffer) {
                    const geojson = await shapefile.read(shpBuffer, dbfBuffer, shxBuffer);

                    if (geojson && geojson.features) {
                        let sourceProj = 'EPSG:25830'; // Por defecto UTM 30N (estándar en la región)
                        if (prjText) {
                            if (prjText.includes('23030')) sourceProj = 'EPSG:23030';
                            else if (prjText.includes('4326')) sourceProj = 'EPSG:4326';
                        }

                        if (sourceProj !== 'EPSG:4326') {
                            geojson.features.forEach(feature => {
                                if (feature.geometry && feature.geometry.coordinates) {
                                    feature.geometry.coordinates = roundCoords(transformCoordinates(feature.geometry.coordinates, sourceProj));
                                }
                            });
                        } else {
                            geojson.features.forEach(feature => {
                                if (feature.geometry && feature.geometry.coordinates) {
                                    feature.geometry.coordinates = roundCoords(feature.geometry.coordinates);
                                }
                            });
                        }

                        return res.json({ isGeoJson: true, geojson: geojson, prj: prjText || 'EPSG:25830' });
                    }
                }

                // Si el ZIP no era un SHP (p. ej. un CSV/XLS comprimido), busca
                // tablas dentro del ZIP antes de rendirse.
                try {
                    const zip2 = new AdmZip(buffer);
                    for (let entry of zip2.getEntries()) {
                        const name = entry.entryName.toLowerCase();
                        if (name.includes('__macosx')) continue;
                        const entryBuf = entry.getData();
                        if (name.endsWith('.kml') || name.endsWith('.xml')) {
                            return res.json({ isMap: true, format: 'KML', rawContent: entryBuf.toString('utf8') });
                        }
                        if (name.endsWith('.geojson') || name.endsWith('.json')) {
                            try {
                                const gj = JSON.parse(entryBuf.toString('utf8'));
                                if (gj.type === 'FeatureCollection' && gj.features) return res.json({ isGeoJson: true, geojson: gj });
                            } catch (e) {}
                        }
                        if (name.endsWith('.csv')) {
                            const parsed = parseCsvText(decodeEntryText(entryBuf));
                            if (parsed) return res.json(parsed);
                        }
                        if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
                            const parsed = parseExcelBuffer(entryBuf);
                            if (parsed) return res.json(parsed);
                        }
                    }
                } catch (e) {
                    console.error("Error buscando tablas en ZIP:", e);
                }
            } catch (shapeErr) {
                console.error("Error leyendo Shapefile ZIP:", shapeErr);
            }
        }

        if (type === 'A' || datastoreActive) {
            try {
                const datastoreUrl = `https://datosabiertos.regiondemurcia.es/api/3/action/datastore_search?resource_id=${resourceId}&limit=300`;
                const response = await fetch(datastoreUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = await response.json();

                if (data.success && data.result && data.result.records) {
                    const records = data.result.records;
                    const rawFields = data.result.fields ? data.result.fields.map(f => f.id) : Object.keys(records[0]);
                    const headers = rawFields.filter(f => f !== '_id');
                    const rows = records.map(record => {
                        let rowObj = {};
                        headers.forEach(h => {
                            let val = record[h];
                            rowObj[h] = (val !== null && val !== undefined) ? String(val) : '';
                        });
                        return rowObj;
                    });
                    return res.json({ headers, rows });
                }
            } catch (dsErr) {
                console.warn('Datastore falló:', dsErr.message);
            }
        }

        if (buffer && (fmt.includes('XLS') || urlLower.endsWith('.xls') || urlLower.endsWith('.xlsx'))) {
            const parsed = parseExcelBuffer(buffer);
            if (parsed) return res.json(parsed);
        }

        if (buffer && (cleanText.startsWith('[') || cleanText.startsWith('{'))) {
            try {
                const jsonData = JSON.parse(cleanText);
                // GeoJSON: es un mapa, no una tabla (antes caía en el CSV y
                // salía una tabla basura en vez del mapa).
                if (jsonData && jsonData.type === 'FeatureCollection' && Array.isArray(jsonData.features)) {
                    jsonData.features.forEach(f => {
                        if (f.geometry && f.geometry.coordinates) {
                            f.geometry.coordinates = roundCoords(f.geometry.coordinates);
                        }
                    });
                    return res.json({ isGeoJson: true, geojson: jsonData });
                }
                const jsonArray = Array.isArray(jsonData) ? jsonData : (jsonData.result || jsonData.data || jsonData.rows || jsonData.records || jsonData.value || null);

                if (jsonArray && Array.isArray(jsonArray) && jsonArray.length > 0) {
                    
                    // Comprobamos si el primer elemento tiene objetos anidados complejos (como el SEF)
                    const hasNestedObjects = Object.values(jsonArray[0]).some(val => val !== null && typeof val === 'object');

                    let flattenedData;

                    if (hasNestedObjects) {
                        // Lógica específica para JSONs anidados (SEF, etc.) que extrae las propiedades internas limpiamente
                        flattenedData = jsonArray.map(item => {
                            let flat = {};
                            for (let p in item) {
                                if (item[p] !== null && typeof item[p] === 'object' && !Array.isArray(item[p])) {
                                    for (let subP in item[p]) {
                                        let subVal = item[p][subP];
                                        if (subVal !== null && typeof subVal === 'object') {
                                            for (let subSubP in subVal) {
                                                flat[`${p}.${subP}.${subSubP}`] = String(subVal[subSubP] ?? '');
                                            }
                                        } else {
                                            flat[`${p}.${subP}`] = String(subVal ?? '');
                                        }
                                    }
                                } else {
                                    flat[p] = item[p] !== null && item[p] !== undefined ? String(item[p]) : '';
                                }
                            }
                            return flat;
                        });
                    } else {
                        // Tu lógica original intacta para los JSONs sencillos que ya te iban bien
                        flattenedData = jsonArray.map(item => {
                            let flat = {};
                            for (let p in item) {
                                if (typeof item[p] !== 'object') flat[p] = item[p];
                                else flat[p] = JSON.stringify(item[p]);
                            }
                            return flat;
                        });
                    }

                    const headersSet = new Set();
                    flattenedData.forEach(row => {
                        Object.keys(row).forEach(h => headersSet.add(h));
                    });
                    const headers = Array.from(headersSet);

                    const rows = flattenedData.map(item => {
                        let rowObj = {};
                        headers.forEach(h => {
                            rowObj[h] = item[h] !== undefined ? String(item[h]) : '';
                        });
                        return rowObj;
                    });

                    return res.json({ headers, rows });
                }
            } catch (jsonErr) {
                console.error("Error parseando JSON:", jsonErr);
            }
        }

        // CSV de texto. No intentar con ZIPs binarios (daban tablas basura).
        const isZipLike = urlLower.endsWith('.zip') || fmt === 'SHP' || fmt === 'ZIP';
        if (!isZipLike) {
            const parsed = parseCsvText(textData);
            if (parsed) return res.json(parsed);
        }

        // Último recurso: si era un recurso de mapa y nada se pudo leer,
        // devolver el enlace para que al menos se pueda abrir/descargar.
        if (type === 'C' || fmt === 'SHP' || fmt === 'ZIP' || fmt === 'KMZ' || fmt === 'KML') {
            return res.json({ isMap: true, format: fmt || 'MAP', mapUrl: downloadUrl });
        }

        res.status(404).json({ error: "No se pudieron procesar los datos de este recurso." });
    } catch (error) {
        console.error("Error al procesar:", error);
        res.status(500).json({ error: "Error técnico al parsear el recurso." });
    }
});

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Visor avanzado activo en http://localhost:${PORT}`);
    });
}

module.exports = app;