const express = require('express');
const { XMLParser } = require('fast-xml-parser');
const XLSX = require('xlsx');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const shapefile = require('shapefile');
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

        const fileRes = await fetch(downloadUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        });
        
        const arrayBuffer = await fileRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const textData = buffer.toString('utf8');
        const cleanText = textData.trim();

        // 1. KML / XML directo
        if (fmt === 'KML' || fmt === 'XML' || urlLower.endsWith('.kml') || urlLower.endsWith('.xml') || cleanText.includes('<kml') || cleanText.includes('<document>') || cleanText.startsWith('<?xml')) {
            return res.json({ isMap: true, format: 'KML', rawContent: textData });
        }

        // 2. KMZ (Extraer el XML/KML de dentro del ZIP al igual que un KML)
        if (urlLower.endsWith('.kmz') || fmt === 'KMZ') {
            try {
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
        if (urlLower.endsWith('.zip') || fmt === 'SHP' || fmt === 'ZIP') {
            try {
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
                                    feature.geometry.coordinates = transformCoordinates(feature.geometry.coordinates, sourceProj);
                                }
                            });
                        }

                        return res.json({ isGeoJson: true, geojson: geojson, prj: prjText || 'EPSG:25830' });
                    }
                }
            } catch (shapeErr) {
                console.error("Error leyendo Shapefile ZIP:", shapeErr);
            }
        }

        if (fmt === 'WMS' || urlLower.includes('wms') || type === 'C') {
            return res.json({ isMap: true, format: fmt || 'WMS', mapUrl: downloadUrl });
        }

        if (type === 'A' || datastoreActive) {
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
        }

        if (fmt.includes('XLS') || urlLower.endsWith('.xls') || urlLower.endsWith('.xlsx')) {
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
            if (jsonData.length > 0) {
                const headers = Object.keys(jsonData[0]);
                const rows = jsonData.map(item => {
                    let rowObj = {};
                    headers.forEach(h => { rowObj[h] = item[h] !== undefined ? String(item[h]) : ''; });
                    return rowObj;
                });
                return res.json({ headers, rows });
            }
        }

        if (cleanText.startsWith('[') || cleanText.startsWith('{')) {
            try {
                const jsonData = JSON.parse(cleanText);
                const jsonArray = Array.isArray(jsonData) ? jsonData : (jsonData.result || jsonData.data || jsonData.rows || jsonData.records || null);

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

        const lines = textData.split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length > 0) {
            const separator = lines[0].includes(';') ? ';' : ',';
            const headers = lines[0].split(separator).map(h => h.replace(/^["']|["']$/g, '').trim());
            let rows = [];
            for (let i = 1; i < Math.min(lines.length, 300); i++) {
                const currentLine = lines[i].split(separator);
                let rowObj = {};
                headers.forEach((h, index) => {
                    rowObj[h] = currentLine[index] !== undefined ? currentLine[index].replace(/^["']|["']$/g, '').trim() : '';
                });
                rows.push(rowObj);
            }
            return res.json({ headers, rows });
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